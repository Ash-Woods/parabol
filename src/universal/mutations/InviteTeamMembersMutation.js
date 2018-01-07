import {commitMutation} from 'react-relay';
import {showInfo, showSuccess} from 'universal/modules/toast/ducks/toastDuck';
import AcceptTeamInviteMutation from 'universal/mutations/AcceptTeamInviteMutation';
import ClearNotificationMutation from 'universal/mutations/ClearNotificationMutation';
import handleAddInvitations from 'universal/mutations/handlers/handleAddInvitations';
import handleAddNotifications from 'universal/mutations/handlers/handleAddNotifications';
import handleAddOrgApprovals from 'universal/mutations/handlers/handleAddOrgApprovals';
import handleAddTeamMembers from 'universal/mutations/handlers/handleAddTeamMembers';
import handleAddTeams from 'universal/mutations/handlers/handleAddTeams';
import handleRemoveNotifications from 'universal/mutations/handlers/handleRemoveNotifications';
import handleRemoveOrgApprovals from 'universal/mutations/handlers/handleRemoveOrgApprovals';
import getInProxy from 'universal/utils/relay/getInProxy';

graphql`
  fragment InviteTeamMembersMutationInvitee_team on InviteTeamMembersInviteePayload {
    team {
      ...CompleteTeamFragWithMembers @relay(mask: false)
    }
  }
`;

graphql`
  fragment InviteTeamMembersMutationInvitee_notification on InviteTeamMembersInviteePayload {
    reactivationNotification {
      type
      ...AddedToTeam_notification @relay(mask: false)
    }
    teamInviteNotification {
      type
      ...TeamInvite_notification @relay(mask: false)
    }
  }
`;

graphql`
  fragment InviteTeamMembersMutationAnnounce_teamMember on InviteTeamMembersAnnouncePayload {
    reactivatedTeamMembers {
      ...CompleteTeamMemberFrag @relay(mask: false)
    }
    team {
      name
    }
  }
`;

graphql`
  fragment InviteTeamMembersMutationAnnounce_orgApproval on InviteTeamMembersAnnouncePayload {
    orgApprovalsSent {
      ...CompleteOrgApprovalFrag @relay(mask: false)
    }
    orgApprovalsRemoved {
      id
    }
  }
`;

graphql`
  fragment InviteTeamMembersMutationAnnounce_invitation on InviteTeamMembersAnnouncePayload {
    invitationsSent {
      ...CompleteInvitationFrag @relay(mask: false)
    }
  }
`;

graphql`
  fragment InviteTeamMembersMutationOrgLeader_notification on InviteTeamMembersOrgLeaderPayload {
    removedRequestNotification {
      id
    }
    requestNotification {
      type
      ...RequestNewUser_notification @relay(mask: false)
    }
  }
`;

const mutation = graphql`
  mutation InviteTeamMembersMutation($teamId: ID!, $invitees: [Invitee!]!) {
    inviteTeamMembers(invitees: $invitees, teamId: $teamId) {
      ...InviteTeamMembersMutationAnnounce_teamMember @relay(mask: false)
      ...InviteTeamMembersMutationAnnounce_orgApproval @relay(mask: false)
      ...InviteTeamMembersMutationAnnounce_invitation @relay(mask: false)
      ...InviteTeamMembersMutationOrgLeader_notification @relay(mask:false)
    }
  }
`;

const popReactivationToast = (reactivatedTeamMembers, dispatch) => {
  const emails = getInProxy(reactivatedTeamMembers, 'email');
  if (!emails) return;
  const isSingular = emails.length === 1;
  const [firstEmail] = emails;
  const emailStr = emails.join(', ');
  const message = isSingular ?
    `${firstEmail} used to be on this team, so they were automatically approved` :
    `The following team members have been reinstated: ${emailStr}`;
  dispatch(showSuccess({
    title: 'Back in it!',
    message
  }));
};

const popTeamMemberReactivatedToast = (payload, dispatch) => {
  // pop 1 toast per reactivation. simple for now
  const teamName = getInProxy(payload, 'team', 'name');
  const reactivatedTeamMembers = payload.getLinkedRecords('reactivatedTeamMembers');
  const names = getInProxy(reactivatedTeamMembers, 'preferredName');
  names.forEach((name) => {
    dispatch(showInfo({
      autoDismiss: 10,
      title: 'They’re back!',
      message: `${name} has rejoined ${teamName}`
    }));
  });
};

const popOrgApprovalToast = (payload, dispatch) => {
  const orgApprovalsSent = payload.getLinkedRecord('orgApprovalsSent');
  const emails = getInProxy(orgApprovalsSent, 'email');
  if (!emails) return;
  const [firstEmail] = emails;
  const emailStr = emails.join(', ');
  dispatch(showSuccess({
    title: 'Request sent to admin',
    message: emails.length === 1 ?
      `A request to add ${firstEmail} has been sent to your organization admin` :
      `The following invitations are awaiting approval from your organization admin: ${emailStr}`
  }));
};

const popInvitationToast = (payload, dispatch) => {
  const invitationsSent = payload.getLinkedRecords('invitationsSent');
  const emails = getInProxy(invitationsSent, 'email');
  if (!emails) return;
  const emailStr = emails.join(', ');
  dispatch(showSuccess({
    title: 'Invitation sent!',
    message: `An invitation has been sent to ${emailStr}`
  }));
};

const popReactivatedNotificationToast = (reactivationNotification, {dispatch, environment}) => {
  const teamName = getInProxy(reactivationNotification, 'team', 'name');
  if (!teamName) return;
  const notificationId = getInProxy(reactivationNotification, 'id');
  dispatch(showInfo({
    autoDismiss: 10,
    title: 'Congratulations!',
    message: `You’ve been added to team ${teamName}`,
    action: {
      label: 'Great!',
      callback: () => {
        ClearNotificationMutation(environment, notificationId);
      }
    }
  }));
};

const popTeamInviteNotificationToast = (teamInviteNotification, {dispatch, environment}) => {
  const inviterName = getInProxy(teamInviteNotification, 'inviter', 'preferredName');
  if (!inviterName) return;
  const teamName = getInProxy(teamInviteNotification, 'team', 'name');
  const notificationId = getInProxy(teamInviteNotification, 'id');
  dispatch(showInfo({
    autoDismiss: 10,
    title: 'You’re invited!',
    message: `${inviterName} would like you to join their team ${teamName}`,
    action: {
      label: 'Accept!',
      callback: () => {
        AcceptTeamInviteMutation(environment, notificationId, dispatch);
      }
    }
  }));
};

const popRequestNewUserNotificationToast = (requestNotification, {dispatch, history}) => {
  const inviterName = getInProxy(requestNotification, 'inviter', 'preferredName');
  if (!inviterName) return;
  dispatch(showInfo({
    autoDismiss: 10,
    title: 'Approval Requested!',
    message: `${inviterName} would like to invite someone to their team`,
    action: {
      label: 'Check it out',
      callback: () => {
        history.push('/me/notifications');
      }
    }
  }));
};

export const inviteTeamMembersInviteeNotificationUpdater = (payload, store, viewerId, options) => {
  const reactivationNotification = payload.getLinkedRecord('reactivationNotification');
  handleAddNotifications(reactivationNotification, store, viewerId);
  popReactivatedNotificationToast(reactivationNotification, options);

  const teamInviteNotification = payload.getLinkedRecord('teamInviteNotification');
  handleAddNotifications(teamInviteNotification, store, viewerId);
  popTeamInviteNotificationToast(teamInviteNotification, options);
};

export const inviteTeamMembersOrgLeaderNotificationUpdater = (payload, store, viewerId, options) => {
  const removedRequestNotificationId = getInProxy(payload, 'removedRequestNotification', 'id');
  handleRemoveNotifications(removedRequestNotificationId, store, viewerId);

  const requestNotification = payload.getLinkedRecord('requestNotification');
  handleAddNotifications(requestNotification, store, viewerId);
  popRequestNewUserNotificationToast(requestNotification, options);
};

export const inviteTeamMembersTeamMemberUpdater = (payload, store, dispatch, isMutator) => {
  const reactivatedTeamMembers = payload.getLinkedRecords('reactivatedTeamMembers');
  handleAddTeamMembers(reactivatedTeamMembers, store);
  if (isMutator) {
    popReactivationToast(reactivatedTeamMembers, dispatch);
  } else {
    popTeamMemberReactivatedToast(payload, dispatch);
  }
};

export const inviteTeamMembesrOrgApprovalUpdater = (payload, store) => {
  const orgApprovalsRemoved = payload.getLinkedRecords('orgApprovalsRemoved');
  const orgApprovalsIdsRemoved = getInProxy(orgApprovalsRemoved, 'id');
  handleRemoveOrgApprovals(orgApprovalsIdsRemoved, store);

  const orgApprovalsSent = payload.getLinkedRecords('orgApprovalsSent');
  handleAddOrgApprovals(orgApprovalsSent, store);
};

export const inviteTeamMembersInvitationUpdater = (payload, store) => {
  const invitationsSent = payload.getLinkedRecords('invitationsSent');
  handleAddInvitations(invitationsSent, store);
};

export const inviteTeamMembersTeamUpdater = (payload, store, viewerId) => {
  const team = payload.getLinkedRecord('team');
  handleAddTeams(team, store, viewerId);
};

const InviteTeamMembersMutation = (environment, invitees, teamId, dispatch, onError, onCompleted) => {
  return commitMutation(environment, {
    mutation,
    variables: {invitees, teamId},
    updater: (store) => {
      const payload = store.getRootField('inviteTeamMembers');
      inviteTeamMembersTeamMemberUpdater(payload, store, dispatch, true);
      inviteTeamMembesrOrgApprovalUpdater(payload, store);
      popOrgApprovalToast(payload, dispatch);
      inviteTeamMembersInvitationUpdater(payload, store);
      popInvitationToast(payload, dispatch);
    },
    onCompleted,
    onError
  });
};

export default InviteTeamMembersMutation;
