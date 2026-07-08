export type EntityId<T extends string> = string & { readonly __entity: T };

export function entityId<T extends string>(value: string): EntityId<T> {
  return value as EntityId<T>;
}

