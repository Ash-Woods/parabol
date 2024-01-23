import DataLoader from 'dataloader'
import {Selectable, sql} from 'kysely'
import {PARABOL_AI_USER_ID} from '../../client/utils/constants'
import getRethink, {RethinkSchema} from '../database/rethinkDriver'
import {RDatum} from '../database/stricterR'
import MeetingSettingsTeamPrompt from '../database/types/MeetingSettingsTeamPrompt'
import MeetingTemplate from '../database/types/MeetingTemplate'
import OrganizationUser from '../database/types/OrganizationUser'
import {Reactable, ReactableEnum} from '../database/types/Reactable'
import Task, {TaskStatusEnum} from '../database/types/Task'
import {SAMLSource} from '../graphql/public/types/SAML'
import getKysely from '../postgres/getKysely'
import {TeamMeetingTemplate} from '../postgres/pg.d'
import {IGetLatestTaskEstimatesQueryResult} from '../postgres/queries/generated/getLatestTaskEstimatesQuery'
import getApprovedOrganizationDomainsByDomainFromPG from '../postgres/queries/getApprovedOrganizationDomainsByDomainFromPG'
import getApprovedOrganizationDomainsFromPG from '../postgres/queries/getApprovedOrganizationDomainsFromPG'
import getGitHubAuthByUserIdTeamId, {
  GitHubAuth
} from '../postgres/queries/getGitHubAuthByUserIdTeamId'
import getGitHubDimensionFieldMaps, {
  GitHubDimensionFieldMap
} from '../postgres/queries/getGitHubDimensionFieldMaps'
import getGitLabDimensionFieldMaps, {
  GitLabDimensionFieldMap
} from '../postgres/queries/getGitLabDimensionFieldMaps'
import getLatestTaskEstimates from '../postgres/queries/getLatestTaskEstimates'
import getMeetingTaskEstimates, {
  MeetingTaskEstimatesResult
} from '../postgres/queries/getMeetingTaskEstimates'
import {AnyMeeting, MeetingTypeEnum} from '../postgres/types/Meeting'
import getRedis from '../utils/getRedis'
import isUserVerified from '../utils/isUserVerified'
import NullableDataLoader from './NullableDataLoader'
import RootDataLoader from './RootDataLoader'
import normalizeResults from './normalizeResults'
import {Team} from '../postgres/queries/getTeamsByIds'
import {Organization} from '../graphql/public/resolverTypes'
import isValid from '../graphql/isValid'

export interface MeetingSettingsKey {
  teamId: string
  meetingType: MeetingTypeEnum
}

export interface MeetingTemplateKey {
  teamId: string
  meetingType: MeetingTypeEnum
}

export interface ReactablesKey {
  id: string
  type: ReactableEnum
}

export interface UserTasksKey {
  first: number
  after?: Date
  userIds: string[]
  teamIds: string[]
  archived?: boolean
  statusFilters: TaskStatusEnum[]
  filterQuery?: string
  includeUnassigned?: boolean
}

const reactableLoaders = [
  {type: 'COMMENT', loader: 'comments'},
  {type: 'REFLECTION', loader: 'retroReflections'},
  {type: 'RESPONSE', loader: 'teamPromptResponses'}
] as const

export const serializeUserTasksKey = (key: UserTasksKey) => {
  const {userIds, teamIds, first, after, archived, statusFilters, filterQuery} = key
  const parts = [
    (userIds?.length && userIds.sort().join(':')) || '*',
    teamIds.sort().join(':'),
    first,
    after || '*',
    archived,
    (statusFilters?.length && statusFilters.sort().join(':')) || '*',
    filterQuery || '*'
  ]
  return parts.join(':')
}

export const commentCountByDiscussionId = (parent: RootDataLoader) => {
  return new DataLoader<string, number, string>(
    async (discussionIds) => {
      const r = await getRethink()
      const groups = (await (
        r
          .table('Comment')
          .getAll(r.args(discussionIds as string[]), {index: 'discussionId'})
          .filter((row: RDatum) =>
            row('isActive').eq(true).and(row('createdBy').ne(PARABOL_AI_USER_ID))
          )
          .group('discussionId') as any
      )
        .count()
        .ungroup()
        .run()) as {group: string; reduction: number}[]
      const lookup: Record<string, number> = {}
      groups.forEach(({group, reduction}) => {
        lookup[group] = reduction
      })
      return discussionIds.map((discussionId) => lookup[discussionId] || 0)
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const latestTaskEstimates = (parent: RootDataLoader) => {
  return new DataLoader<string, IGetLatestTaskEstimatesQueryResult[], string>(
    async (taskIds) => {
      const rows = await getLatestTaskEstimates(taskIds)
      return taskIds.map((taskId) => rows.filter((row) => row.taskId === taskId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const meetingTaskEstimates = (parent: RootDataLoader) => {
  return new DataLoader<{meetingId: string; taskId: string}, MeetingTaskEstimatesResult[], string>(
    async (keys) => {
      const meetingIds = keys.map(({meetingId}) => meetingId)
      const taskIds = keys.map(({taskId}) => taskId)

      const rows = await getMeetingTaskEstimates(taskIds, meetingIds)
      return keys.map(({meetingId, taskId}) =>
        rows.filter((row) => row.taskId === taskId && row.meetingId === meetingId)
      )
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.meetingId}:${key.taskId}`
    }
  )
}

export const reactables = (parent: RootDataLoader) => {
  return new DataLoader<ReactablesKey, Reactable, string>(
    async (keys) => {
      const reactableResults = (await Promise.all(
        reactableLoaders.map(async (val) => {
          const ids = keys.filter((key) => key.type === val.type).map(({id}) => id)
          return parent.get(val.loader).loadMany(ids)
        })
      )) as Reactable[][]
      const reactables = reactableResults.flat()
      const keyIds = keys.map(({id}) => id)
      const ret = normalizeResults(keyIds, reactables)
      return ret
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.id}:${key.type}`
    }
  )
}

export const userTasks = (parent: RootDataLoader) => {
  return new DataLoader<UserTasksKey, Task[], string>(
    async (keys) => {
      const r = await getRethink()
      const uniqKeys = [] as UserTasksKey[]
      const keySet = new Set()
      keys.forEach((key) => {
        const serializedKey = serializeUserTasksKey(key)
        if (!keySet.has(serializedKey)) {
          keySet.add(serializedKey)
          uniqKeys.push(key)
        }
      })
      const taskLoader = parent.get('tasks')

      const entryArray = await Promise.all(
        uniqKeys.map(async (key) => {
          const {
            first,
            after,
            userIds,
            teamIds,
            archived,
            statusFilters,
            filterQuery,
            includeUnassigned
          } = key
          const dbAfter = after ? new Date(after) : r.maxval

          let teamTaskPartial = r.table('Task').getAll(r.args(teamIds), {index: 'teamId'})
          if (userIds?.length) {
            teamTaskPartial = teamTaskPartial.filter((row: RDatum) =>
              r(userIds).contains(row('userId'))
            )
          }
          if (statusFilters?.length) {
            teamTaskPartial = teamTaskPartial.filter((row: RDatum) =>
              r(statusFilters).contains(row('status'))
            )
          }
          if (filterQuery) {
            // TODO: deal with tags like #archived and #private. should strip out of plaintextContent??
            teamTaskPartial = teamTaskPartial.filter(
              (row: RDatum) => row('plaintextContent').match(filterQuery) as any
            )
          }

          return {
            key: serializeUserTasksKey(key),
            data: await teamTaskPartial
              .filter((task: RDatum) => task('updatedAt').lt(dbAfter))
              .filter((task: RDatum) =>
                archived
                  ? task('tags').contains('archived')
                  : task('tags').contains('archived').not()
              )
              .filter((task: RDatum) => {
                if (includeUnassigned) return true
                return task('userId').ne(null)
              })
              .orderBy(r.desc('updatedAt'))
              .limit(first + 1)
              .run()
          }
        })
      )

      const tasksByKey = Object.assign(
        {},
        ...entryArray.map((entry) => ({[entry.key]: entry.data}))
      ) as {[key: string]: Task[]}
      const tasks = Object.values(tasksByKey)
      tasks.flat().forEach((task) => {
        taskLoader.clear(task.id).prime(task.id, task)
      })
      return keys.map((key) => tasksByKey[serializeUserTasksKey(key)]!)
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: serializeUserTasksKey
    }
  )
}

export const githubAuth = (parent: RootDataLoader) => {
  return new DataLoader<{teamId: string; userId: string}, GitHubAuth | null, string>(
    async (keys) => {
      const results = await Promise.allSettled(
        keys.map(async ({teamId, userId}) => getGitHubAuthByUserIdTeamId(userId, teamId))
      )
      const vals = results.map((result) => (result.status === 'fulfilled' ? result.value : null))
      return vals
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: ({teamId, userId}) => `${userId}:${teamId}`
    }
  )
}

export const gitlabDimensionFieldMaps = (parent: RootDataLoader) => {
  return new DataLoader<
    {teamId: string; dimensionName: string; projectId: number; providerId: number},
    GitLabDimensionFieldMap | null,
    string
  >(
    async (keys) => {
      const results = await Promise.allSettled(
        keys.map(async ({teamId, dimensionName, projectId, providerId}) =>
          getGitLabDimensionFieldMaps(teamId, dimensionName, projectId, providerId)
        )
      )
      const vals = results.map((result) => (result.status === 'fulfilled' ? result.value : null))
      return vals
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: ({teamId, dimensionName, projectId, providerId}) =>
        `${teamId}:${dimensionName}:${projectId}:${providerId}`
    }
  )
}

export const githubDimensionFieldMaps = (parent: RootDataLoader) => {
  return new DataLoader<
    {teamId: string; dimensionName: string; nameWithOwner: string},
    GitHubDimensionFieldMap | null,
    string
  >(
    async (keys) => {
      const results = await Promise.allSettled(
        keys.map(async ({teamId, dimensionName, nameWithOwner}) =>
          getGitHubDimensionFieldMaps(teamId, dimensionName, nameWithOwner)
        )
      )
      const vals = results.map((result) => (result.status === 'fulfilled' ? result.value : null))
      return vals
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: ({teamId, dimensionName, nameWithOwner}) =>
        `${teamId}:${dimensionName}:${nameWithOwner}`
    }
  )
}

export const meetingSettingsByType = (parent: RootDataLoader) => {
  return new DataLoader<MeetingSettingsKey, RethinkSchema['MeetingSettings']['type'], string>(
    async (keys) => {
      const r = await getRethink()
      const types = {} as Record<MeetingTypeEnum, string[]>
      keys.forEach((key) => {
        const {meetingType} = key
        types[meetingType] = types[meetingType] || []
        types[meetingType].push(key.teamId)
      })
      const entries = Object.entries(types) as [MeetingTypeEnum, string[]][]
      const resultsByType = await Promise.all(
        entries.map((entry) => {
          const [meetingType, teamIds] = entry
          return r
            .table('MeetingSettings')
            .getAll(r.args(teamIds), {index: 'teamId'})
            .filter({meetingType: meetingType})
            .run()
        })
      )
      const docs = resultsByType.flat()
      return keys.map((key) => {
        const {teamId, meetingType} = key
        // until we decide the final shape of the team prompt settings, let's return a temporary hardcoded value
        if (meetingType === 'teamPrompt') {
          return new MeetingSettingsTeamPrompt({teamId})
        }
        return docs.find((doc) => doc.teamId === teamId && doc.meetingType === meetingType)!
      })
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.teamId}:${key.meetingType}`
    }
  )
}

export const organizationApprovedDomainsByOrgId = (parent: RootDataLoader) => {
  return new DataLoader<string, string[], string>(
    async (orgIds) => {
      const currentApprovals = await getApprovedOrganizationDomainsFromPG(orgIds)
      return orgIds.map((orgId) => {
        return currentApprovals
          .filter((approval) => approval.orgId === orgId)
          .map((approval) => approval.domain)
      })
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const organizationApprovedDomains = (parent: RootDataLoader) => {
  return new DataLoader<string, boolean, string>(
    async (domains) => {
      const currentApprovals = await getApprovedOrganizationDomainsByDomainFromPG(domains)
      return domains.map((domain) => {
        return !!currentApprovals.find((approval) => approval.domain === domain)
      })
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const organizationUsersByUserIdOrgId = (parent: RootDataLoader) => {
  return new DataLoader<{orgId: string; userId: string}, OrganizationUser | null, string>(
    async (keys) => {
      const r = await getRethink()
      return Promise.all(
        keys.map((key) => {
          const {userId, orgId} = key
          if (!userId || !orgId) return null
          return r
            .table('OrganizationUser')
            .getAll(userId, {index: 'userId'})
            .filter({orgId, removedAt: null})
            .nth(0)
            .default(null)
            .run()
        })
      )
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.orgId}:${key.userId}`
    }
  )
}

export const meetingTemplatesByType = (parent: RootDataLoader) => {
  return new DataLoader<MeetingTemplateKey, MeetingTemplate[], string>(
    async (keys) => {
      const types = {} as Record<MeetingTypeEnum, string[]>
      keys.forEach((key) => {
        const {meetingType} = key
        types[meetingType] = types[meetingType] || []
        types[meetingType].push(key.teamId)
      })
      const entries = Object.entries(types) as [MeetingTypeEnum, string[]][]
      const resultsByType = await Promise.all(
        entries.map((entry) => {
          const [meetingType, teamIds] = entry
          const pg = getKysely()
          return pg
            .selectFrom('MeetingTemplate')
            .selectAll()
            .where('teamId', 'in', teamIds)
            .where('isActive', '=', true)
            .where('type', '=', meetingType)
            .execute()
        })
      )
      const docs = resultsByType.flat()
      return keys.map((key) => {
        const {teamId, meetingType} = key
        return docs.filter((doc) => doc.teamId === teamId && doc.type === meetingType)!
      })
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.teamId}:${key.meetingType}`
    }
  )
}

// :TODO:(jmtaber129): Generalize this to all meeting types if needed.
export const teamMeetingTemplateByTeamId = (parent: RootDataLoader) => {
  return new DataLoader<string, Selectable<TeamMeetingTemplate>[], string>(
    async (teamIds) => {
      const pg = getKysely()
      const teamMeetingTemplates = await pg
        .selectFrom('TeamMeetingTemplate')
        .selectAll()
        .where('teamId', 'in', teamIds)
        .execute()
      return teamIds.map((teamId) => {
        return teamMeetingTemplates.filter(
          (teamMeetingTemplate) => teamMeetingTemplate.teamId === teamId
        )
      })
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const meetingTemplatesByOrgId = (parent: RootDataLoader) => {
  return new DataLoader<string, MeetingTemplate[], string>(
    async (orgIds) => {
      const pg = getKysely()
      const docs = await pg
        .selectFrom('MeetingTemplate')
        .selectAll()
        .where('orgId', 'in', orgIds)
        .where('isActive', '=', true)
        .where(({or, cmpr}) =>
          or([
            cmpr('hideStartingAt', 'is', null),
            sql`make_date(2020 , extract(month from current_date)::integer, extract(day from current_date)::integer) between "hideEndingAt" and "hideStartingAt"`,
            sql`make_date(2019 , extract(month from current_date)::integer, extract(day from current_date)::integer) between "hideEndingAt" and "hideStartingAt"`
          ])
        )
        .orderBy('createdAt', 'desc')
        .execute()
      return orgIds.map((orgId) => docs.filter((doc) => doc.orgId === orgId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const meetingTemplatesByTeamId = (parent: RootDataLoader) => {
  return new DataLoader<string, MeetingTemplate[], string>(
    async (teamIds) => {
      const pg = getKysely()
      const docs = await pg
        .selectFrom('MeetingTemplate')
        .selectAll()
        .where('teamId', 'in', teamIds)
        .where('isActive', '=', true)
        .execute()
      return teamIds.map((teamId) => docs.filter((doc) => doc.teamId === teamId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

type MeetingStat = {
  id: string
  meetingType: MeetingTypeEnum
  createdAt: Date
}
export const meetingStatsByOrgId = (parent: RootDataLoader) => {
  return new DataLoader<string, MeetingStat[], string>(
    async (orgIds) => {
      const r = await getRethink()
      const meetingStatsByOrgId = await Promise.all(
        orgIds.map(async (orgId) => {
          // note: does not include archived teams!
          const teams = await parent.get('teamsByOrgIds').load(orgId)
          const teamIds = teams.map(({id}) => id)
          const stats = (await r
            .table('NewMeeting')
            .getAll(r.args(teamIds), {index: 'teamId'})
            .pluck('createdAt', 'meetingType')
            // DO NOT CALL orderBy, it makes the query 10x more expensive!
            // .orderBy('createdAt')
            .run()) as {createdAt: Date; meetingType: MeetingTypeEnum}[]
          return stats.map((stat) => ({
            createdAt: stat.createdAt,
            meetingType: stat.meetingType,
            id: `ms${stat.createdAt.getTime()}`
          }))
        })
      )
      return meetingStatsByOrgId
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const teamStatsByOrgId = (parent: RootDataLoader) => {
  return new DataLoader<string, {id: string; createdAt: Date}[], string>(
    async (orgIds) => {
      const teamStatsByOrgId = await Promise.all(
        orgIds.map(async (orgId) => {
          const teams = await parent.get('teamsByOrgIds').load(orgId)
          return teams.map((team) => ({
            id: `ts:${team.createdAt.getTime()}`,
            createdAt: team.createdAt
          }))
        })
      )
      return teamStatsByOrgId
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const taskIdsByTeamAndGitHubRepo = (parent: RootDataLoader) => {
  return new DataLoader<{teamId: string; nameWithOwner: string}, string[], string>(
    async (keys) => {
      const r = await getRethink()
      const res = await Promise.all(
        keys.map((key) => {
          const {teamId, nameWithOwner} = key
          // This is very expensive! We should move tasks to PG ASAP
          return r
            .table('Task')
            .getAll(teamId, {index: 'teamId'})
            .filter((row: RDatum) => row('integration')('nameWithOwner').eq(nameWithOwner))('id')
            .run()
        })
      )
      return res
    },
    {
      ...parent.dataLoaderOptions,
      cacheKeyFn: (key) => `${key.teamId}:${key.nameWithOwner}`
    }
  )
}

export const meetingHighlightedTaskId = (parent: RootDataLoader) => {
  return new DataLoader<string, string | null, string>(
    async (meetingIds) => {
      const redis = getRedis()
      const redisKeys = meetingIds.map((id) => `meetingTaskHighlight:${id}`)
      const highlightedTaskIds = await redis.mget(redisKeys)
      return highlightedTaskIds
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const activeMeetingsByMeetingSeriesId = (parent: RootDataLoader) => {
  return new DataLoader<number, AnyMeeting[], string>(
    async (keys) => {
      const r = await getRethink()
      const res = await Promise.all(
        keys.map((key) => {
          return r
            .table('NewMeeting')
            .getAll(key, {index: 'meetingSeriesId'})
            .filter({endedAt: null}, {default: true})
            .orderBy(r.asc('createdAt'))
            .run()
        })
      )
      return res
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const lastMeetingByMeetingSeriesId = (parent: RootDataLoader) => {
  return new DataLoader<number, AnyMeeting | null, string>(
    async (keys) => {
      const r = await getRethink()
      const res = await Promise.all(
        keys.map((key) => {
          return r
            .table('NewMeeting')
            .getAll(key, {index: 'meetingSeriesId'})
            .orderBy(r.desc('createdAt'))
            .nth(0)
            .default(null)
            .run()
        })
      )
      return res
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const billingLeadersIdsByOrgId = (parent: RootDataLoader) => {
  return new DataLoader<string, string[], string>(
    async (keys) => {
      const r = await getRethink()
      const res = await Promise.all(
        keys.map((orgId) => {
          return r
            .table('OrganizationUser')
            .getAll(orgId, {index: 'orgId'})
            .filter({removedAt: null})
            .filter((row: RDatum) => r.expr(['BILLING_LEADER', 'ORG_ADMIN']).contains(row('role')))
            .coerceTo('array')('userId')
            .run()
        })
      )
      return res
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const saml = (parent: RootDataLoader) => {
  return new NullableDataLoader<string, SAMLSource | null, string>(
    async (samlIds) => {
      const pg = getKysely()
      const res = await pg
        .selectFrom('SAMLDomain')
        .innerJoin('SAML', 'SAML.id', 'SAMLDomain.samlId')
        .where('SAML.id', 'in', samlIds)
        .groupBy('SAML.id')
        .selectAll('SAML')
        .select(({fn}) => [fn.agg<string[]>('array_agg', ['SAMLDomain.domain']).as('domains')])
        .execute()
      return samlIds.map((samlId) => res.find((row) => row.id === samlId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const samlByDomain = (parent: RootDataLoader) => {
  return new NullableDataLoader<string, SAMLSource | null, string>(
    async (domains) => {
      const pg = getKysely()
      const res = await pg
        .selectFrom('SAMLDomain')
        .innerJoin('SAML', 'SAML.id', 'SAMLDomain.samlId')
        .where('SAMLDomain.domain', 'in', domains)
        .groupBy('SAML.id')
        .selectAll('SAML')
        .select(({fn}) => [fn.agg<string[]>('array_agg', ['SAMLDomain.domain']).as('domains')])
        .execute()
      return domains.map((domain) => res.find((row) => row.domains.includes(domain)))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const samlByOrgId = (parent: RootDataLoader) => {
  return new NullableDataLoader<string, SAMLSource | null, string>(
    async (orgIds) => {
      const pg = getKysely()
      const res = await pg
        .selectFrom('SAMLDomain')
        .innerJoin('SAML', 'SAML.id', 'SAMLDomain.samlId')
        .where('SAML.orgId', 'in', orgIds)
        .groupBy('SAML.id')
        .selectAll('SAML')
        .select(({fn}) => [fn.agg<string[]>('array_agg', ['SAMLDomain.domain']).as('domains')])
        .execute()
      return orgIds.map((orgId) => res.find((row) => row.orgId === orgId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

type OrgWithFounderAndLeads = Organization & {
  founder: OrganizationUser | null
  billingLeads: OrganizationUser[]
}

// Check if the org has a founder or billing lead with a verified email and their email domain is the same as the org domain
export const isOrgVerified = (parent: RootDataLoader) => {
  return new DataLoader<string, boolean, string>(
    async (orgIds) => {
      const r = await getRethink()
      const orgs: OrgWithFounderAndLeads[] = await r
        .table('Organization')
        .getAll(r.args(orgIds))
        .merge((org: RDatum) => ({
          members: r
            .table('OrganizationUser')
            .getAll(org('id'), {index: 'orgId'})
            .orderBy('joinedAt')
            .coerceTo('array')
        }))
        .merge((org: RDatum) => ({
          founder: org('members').nth(0).default(null),
          billingLeads: org('members')
            .filter({inactive: false})
            .filter((row: RDatum) => r.expr(['BILLING_LEADER', 'ORG_ADMIN']).contains(row('role')))
        }))
        .run()

      const userIds = orgs
        .flatMap((org) => [
          org.founder ? org.founder.userId : null,
          ...org.billingLeads.map((lead) => lead.userId)
        ])
        .filter((id): id is string => Boolean(id))

      const users = (await parent.get('users').loadMany(userIds)).filter(isValid)

      return orgIds.map((orgId) => {
        const isValid = orgs.some((org) => {
          if (org.id !== orgId) return false
          const checkEmailDomain = (userId: string) => {
            const user = users.find((user) => user.id === userId)
            if (!user) return false
            return isUserVerified(user) && user.domain === org.activeDomain
          }
          return [org.founder, ...org.billingLeads].some(
            (orgUser) => orgUser && !orgUser.inactive && checkEmailDomain(orgUser.userId)
          )
        })
        return isValid
      })
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

export const autoJoinTeamsByOrgId = (parent: RootDataLoader) => {
  return new DataLoader<string, Team[], string>(
    async (orgIds) => {
      const verificationResults = await parent.get('isOrgVerified').loadMany(orgIds)
      const verifiedOrgIds = orgIds.filter((_, index) => verificationResults[index])

      const pg = getKysely()

      const teams =
        verifiedOrgIds.length === 0
          ? []
          : ((await pg
              .selectFrom('Team')
              .where('orgId', 'in', verifiedOrgIds)
              .where('autoJoin', '=', true)
              .where('isArchived', '!=', true)
              .selectAll()
              .execute()) as unknown as Team[])

      return orgIds.map((orgId) => teams.filter((team) => team.orgId === orgId))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}

/**
 * Assuming the input is a domain, is it also a company domain?
 */
export const isCompanyDomain = (parent: RootDataLoader) => {
  return new DataLoader<string, boolean, string>(
    async (domains) => {
      const pg = getKysely()
      const res = await pg
        .selectFrom('FreemailDomain')
        .where('domain', 'in', domains)
        .select('domain')
        .execute()
      const freemailDomains = new Set(res.map(({domain}) => domain))
      return domains.map((domain) => !freemailDomains.has(domain))
    },
    {
      ...parent.dataLoaderOptions
    }
  )
}
