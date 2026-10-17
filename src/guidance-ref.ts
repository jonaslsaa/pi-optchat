/** A reference to an immutable request record, kept outside ordinary conversation text. */
export interface GuidanceRef { request: string }
export const validRequestId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export function validGuidanceRef(value: unknown): value is GuidanceRef {
  return typeof value === 'object' && value !== null && 'request' in value && typeof value.request === 'string' && validRequestId(value.request);
}
