import { BusinessRole, MembershipStatus, PlatformRole } from "@prisma/client";

export type PermissionFlags = {
  canViewOperationalQueues: boolean;
  canViewLeads: boolean;
  canViewAllOperationalLeads: boolean;
  canClaimUnassignedLeads: boolean;
  canAssignLeadsToSelf: boolean;
  canReassignLeadsToOthers: boolean;
  canManageAllLeads: boolean;
  canViewConversations: boolean;
  canViewAllOperationalConversations: boolean;
  canClaimUnassignedConversations: boolean;
  canAssignConversationsToSelf: boolean;
  canReassignConversationsToOthers: boolean;
  canManageAllConversations: boolean;
  canViewAppointments: boolean;
  canViewAllOperationalAppointments: boolean;
  canClaimUnassignedAppointments: boolean;
  canAssignAppointmentsToSelf: boolean;
  canReassignAppointmentsToOthers: boolean;
  canManageAllAppointments: boolean;
  canViewAiHandoffTasks: boolean;
  canClaimUnassignedAiHandoffTasks: boolean;
  canAssignAiHandoffTasksToSelf: boolean;
  canReassignAiHandoffTasksToOthers: boolean;
  canManageBilling: boolean;
  canManageTeam: boolean;
  canManageBusinessSettings: boolean;
  canCreateBusiness: boolean;
};

export function permissionList(role?: BusinessRole | PlatformRole | null) {
  if (role === PlatformRole.PLATFORM_ADMIN) return ["platform:admin"];
  if (role === BusinessRole.BUSINESS_OWNER) return ["business:manage", "subscription:manage", "members:manage", "leads:view_all", "leads:create", "leads:update_all", "leads:assign", "leads:delete", "conversations:view_all", "conversations:create", "conversations:send", "conversations:assign", "conversations:update_status", "conversations:delete"];
  if (role === BusinessRole.MANAGER) return ["business:manage", "members:view", "leads:view_all", "leads:create", "leads:update_all", "leads:assign", "leads:delete", "conversations:view_all", "conversations:create", "conversations:send", "conversations:assign", "conversations:update_status", "conversations:delete"];
  if (role === BusinessRole.STAFF) return ["business:view", "leads:view_assigned", "leads:create", "leads:update_assigned", "conversations:view_assigned", "conversations:create_assigned", "conversations:send_assigned", "conversations:update_status_assigned"];
  return [];
}

export function permissionFlags(input: {
  role?: BusinessRole | PlatformRole | null;
  membershipStatus?: MembershipStatus | null;
  canCreateBusiness?: boolean;
}): PermissionFlags {
  const active = input.membershipStatus === MembershipStatus.ACTIVE;
  const owner = active && input.role === BusinessRole.BUSINESS_OWNER;
  const manager = active && input.role === BusinessRole.MANAGER;
  const staff = active && input.role === BusinessRole.STAFF;
  const platformAdmin = input.role === PlatformRole.PLATFORM_ADMIN;
  const operational = platformAdmin || owner || manager || staff;
  const canReassign = platformAdmin || owner || manager;
  const canClaim = operational;
  return {
    canViewOperationalQueues: operational,
    canViewLeads: operational,
    canViewAllOperationalLeads: platformAdmin || owner || manager,
    canClaimUnassignedLeads: canClaim,
    canAssignLeadsToSelf: canClaim,
    canReassignLeadsToOthers: canReassign,
    canManageAllLeads: platformAdmin || owner || manager,
    canViewConversations: operational,
    canViewAllOperationalConversations: platformAdmin || owner || manager,
    canClaimUnassignedConversations: canClaim,
    canAssignConversationsToSelf: canClaim,
    canReassignConversationsToOthers: canReassign,
    canManageAllConversations: platformAdmin || owner || manager,
    canViewAppointments: operational,
    canViewAllOperationalAppointments: platformAdmin || owner || manager,
    canClaimUnassignedAppointments: canClaim,
    canAssignAppointmentsToSelf: canClaim,
    canReassignAppointmentsToOthers: canReassign,
    canManageAllAppointments: platformAdmin || owner || manager,
    canViewAiHandoffTasks: operational,
    canClaimUnassignedAiHandoffTasks: canClaim,
    canAssignAiHandoffTasksToSelf: canClaim,
    canReassignAiHandoffTasksToOthers: canReassign,
    canManageBilling: platformAdmin || owner,
    canManageTeam: platformAdmin || owner,
    canManageBusinessSettings: platformAdmin || owner || manager,
    canCreateBusiness: Boolean(input.canCreateBusiness),
  };
}
