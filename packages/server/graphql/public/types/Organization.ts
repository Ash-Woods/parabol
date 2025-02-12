import {
  getUserId,
  isSuperUser,
  isTeamMember,
  isUserBillingLeader,
  isUserOrgAdmin
} from '../../../utils/authorization'
import {getFeatureTier} from '../../types/helpers/getFeatureTier'
import {OrganizationResolvers} from '../resolverTypes'
import getActiveTeamCountByOrgIds from './helpers/getActiveTeamCountByOrgIds'

const Organization: OrganizationResolvers = {
  approvedDomains: async ({id: orgId}, _args, {dataLoader}) => {
    return dataLoader.get('organizationApprovedDomainsByOrgId').load(orgId)
  },
  meetingStats: async ({id: orgId}, _args, {dataLoader}) => {
    return dataLoader.get('meetingStatsByOrgId').load(orgId)
  },
  teamStats: async ({id: orgId}, _args, {dataLoader}) => {
    return dataLoader.get('teamStatsByOrgId').load(orgId)
  },
  company: async ({activeDomain}, _args, {authToken}) => {
    if (!activeDomain || !isSuperUser(authToken)) return null
    return {id: activeDomain}
  },
  featureFlags: ({featureFlags}) => {
    if (!featureFlags) return {}
    return Object.fromEntries(featureFlags.map((flag) => [flag as any, true]))
  },
  picture: async ({picture}, _args, {dataLoader}) => {
    if (!picture) return null
    return dataLoader.get('fileStoreAsset').load(picture)
  },
  tier: ({tier, trialStartDate}) => {
    return getFeatureTier({tier, trialStartDate})
  },
  billingTier: ({tier}) => tier,
  saml: async ({id: orgId}, _args, {dataLoader}) => {
    const saml = await dataLoader.get('samlByOrgId').load(orgId)
    return saml || null
  },

  isBillingLeader: async ({id: orgId}, _args, {authToken, dataLoader}) => {
    const viewerId = getUserId(authToken)
    return isUserBillingLeader(viewerId, orgId, dataLoader)
  },

  isOrgAdmin: async ({id: orgId}, _args, {authToken, dataLoader}) => {
    const viewerId = getUserId(authToken)
    return isUserOrgAdmin(viewerId, orgId, dataLoader)
  },

  activeTeamCount: async ({id: orgId}) => {
    return getActiveTeamCountByOrgIds(orgId)
  },

  allTeams: async ({id: orgId}, _args, {dataLoader, authToken}) => {
    const viewerId = getUserId(authToken)
    const [allTeamsOnOrg, organization, isOrgAdmin] = await Promise.all([
      dataLoader.get('teamsByOrgIds').load(orgId),
      dataLoader.get('organizations').loadNonNull(orgId),
      isUserOrgAdmin(viewerId, orgId, dataLoader)
    ])
    const sortedTeamsOnOrg = allTeamsOnOrg.sort((a, b) => a.name.localeCompare(b.name))
    const hasPublicTeamsFlag = !!organization.featureFlags?.includes('publicTeams')
    if (isOrgAdmin || isSuperUser(authToken) || hasPublicTeamsFlag) {
      const viewerTeams = sortedTeamsOnOrg.filter((team) => authToken.tms.includes(team.id))
      const otherTeams = sortedTeamsOnOrg.filter((team) => !authToken.tms.includes(team.id))
      return [...viewerTeams, ...otherTeams]
    } else {
      return sortedTeamsOnOrg.filter((team) => authToken.tms.includes(team.id))
    }
  },

  viewerTeams: async ({id: orgId}, _args, {dataLoader, authToken}) => {
    const allTeamsOnOrg = await dataLoader.get('teamsByOrgIds').load(orgId)
    return allTeamsOnOrg
      .filter((team) => authToken.tms.includes(team.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  },

  publicTeams: async ({id: orgId}, _args, {dataLoader, authToken}) => {
    const [allTeamsOnOrg, organization] = await Promise.all([
      dataLoader.get('teamsByOrgIds').load(orgId),
      dataLoader.get('organizations').loadNonNull(orgId)
    ])
    const hasPublicTeamsFlag = !!organization.featureFlags?.includes('publicTeams')
    if (!isSuperUser(authToken) || !hasPublicTeamsFlag) return []
    const publicTeams = allTeamsOnOrg.filter((team) => !isTeamMember(authToken, team.id))
    return publicTeams
  },

  viewerOrganizationUser: async ({id: orgId}, _args, {dataLoader, authToken}) => {
    const viewerId = getUserId(authToken)
    return dataLoader.get('organizationUsersByUserIdOrgId').load({userId: viewerId, orgId})
  },

  organizationUsers: async ({id: orgId}, _args, {dataLoader}) => {
    const organizationUsers = await dataLoader.get('organizationUsersByOrgId').load(orgId)
    organizationUsers.sort((a, b) => (a.orgId > b.orgId ? 1 : -1))
    const edges = organizationUsers.map((node) => ({
      cursor: node.id,
      node
    }))
    // TODO implement pagination
    const firstEdge = edges[0]
    return {
      edges,
      pageInfo: {
        endCursor: firstEdge ? edges[edges.length - 1]!.cursor : null,
        hasNextPage: false,
        hasPreviousPage: false
      }
    }
  },

  orgUserCount: async ({id: orgId}, _args, {dataLoader}) => {
    const organizationUsers = await dataLoader.get('organizationUsersByOrgId').load(orgId)
    const inactiveUserCount = organizationUsers.filter(({inactive}) => inactive).length
    return {
      inactiveUserCount,
      activeUserCount: organizationUsers.length - inactiveUserCount
    }
  },

  billingLeaders: async ({id: orgId}, _args, {dataLoader}) => {
    const organizationUsers = await dataLoader.get('organizationUsersByOrgId').load(orgId)
    return organizationUsers.filter(
      (organizationUser) =>
        organizationUser.role === 'BILLING_LEADER' || organizationUser.role === 'ORG_ADMIN'
    )
  }
}

export default Organization
