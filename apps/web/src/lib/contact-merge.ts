import type { ContactOption, TodayPayload } from "@embed-os/contracts";

export interface MergeTargetOption {
  contact: ContactOption;
  organizationNames: string[];
}

export function collectMergeTargets(
  payload: TodayPayload,
  sourceContactId: string,
): MergeTargetOption[] {
  const contacts = new Map<string, MergeTargetOption>();
  for (const action of payload.actions) {
    for (const contact of action.contacts) {
      if (contact.id === sourceContactId) continue;
      const current = contacts.get(contact.id);
      if (current) {
        if (!current.organizationNames.includes(action.organizationName)) {
          current.organizationNames.push(action.organizationName);
        }
      } else {
        contacts.set(contact.id, {
          contact,
          organizationNames: [action.organizationName],
        });
      }
    }
  }
  return [...contacts.values()].sort(
    (left, right) =>
      left.contact.fullName.localeCompare(right.contact.fullName, "ru") ||
      left.contact.id.localeCompare(right.contact.id),
  );
}

export function applyContactMerge(
  payload: TodayPayload,
  sourceContactId: string,
  targetContactId: string,
): TodayPayload {
  const target = payload.actions
    .flatMap((action) => action.contacts)
    .find(({ id }) => id === targetContactId);
  if (!target) return payload;

  return {
    ...payload,
    actions: payload.actions.map((action) => {
      const source = action.contacts.find(({ id }) => id === sourceContactId);
      if (!source) return action;
      if (action.contacts.some(({ id }) => id === targetContactId)) {
        return {
          ...action,
          contacts: action.contacts.filter(({ id }) => id !== sourceContactId),
        };
      }
      return {
        ...action,
        contacts: action.contacts.map((contact) =>
          contact.id === sourceContactId
            ? {
                ...target,
                role: source.role,
                department: source.department,
                isPrimary: source.isPrimary,
              }
            : contact,
        ),
      };
    }),
  };
}
