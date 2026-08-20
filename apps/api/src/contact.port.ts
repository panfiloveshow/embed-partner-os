import type {
  ContactOption,
  ContactRegistryItem,
  ContactRegistryPayload,
  MergeContactResult,
} from "@embed-os/contracts";

export const CONTACT_PORT = Symbol("CONTACT_PORT");

export interface ContactPort {
  listContacts(query?: {
    search?: string;
    status?: string;
    organizationId?: string;
    duplicatesOnly?: boolean;
  }): ContactRegistryPayload | Promise<ContactRegistryPayload>;
  createContact(
    organizationId: string,
    input: unknown,
    idempotencyKey: string,
  ): ContactOption | Promise<ContactOption>;
  linkContact(
    organizationId: string,
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): ContactOption | Promise<ContactOption>;
  mergeContact(
    sourceContactId: string,
    input: unknown,
    idempotencyKey: string,
  ): MergeContactResult | Promise<MergeContactResult>;
  updateContact(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): ContactRegistryItem | Promise<ContactRegistryItem>;
  archiveContact(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): ContactRegistryItem | Promise<ContactRegistryItem>;
  restoreContact(
    contactId: string,
    input: unknown,
    idempotencyKey: string,
  ): ContactRegistryItem | Promise<ContactRegistryItem>;
}
