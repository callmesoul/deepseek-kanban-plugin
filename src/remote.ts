/**
 * Hand-written Typert Remote contribution for the `kanban` namespace.
 *
 * The host service is discovered by the gateway's SRC fallback (the
 * `TypertRemoteService` binding + `@Remote` markers in `lib/index.js`), which
 * derives wire argument keys from the host method parameter names. The wire
 * keys here MUST therefore match those parameter names exactly (`input`).
 *
 * Strict codecs are required by the client mount, and the Typert registry goes
 * one step further: `DescriptorStore.validate` -> `validateCodec` rejects any
 * strict codec whose `create` is not a function with
 * `typert: <id> ... strict codec has no create() factory`. A missing factory
 * fails the whole `$mount` batch, which in turn fails the plugin fiber at boot
 * (`web boot: 1 entry did not activate`).
 *
 * The schema is a passthrough on purpose: the host SRC path already treats
 * values as loose JSON and this boundary is a trusted in-process bridge, so the
 * client bundle does not need zod. `create` still has to return an object with
 * the chainable surface the generator calls on a materialized schema, so the
 * passthrough stays chainable.
 */
type PassthroughSchema = {
  parse: (value: unknown) => unknown;
  optional: () => PassthroughSchema;
  nonoptional: () => PassthroughSchema;
  nullable: () => PassthroughSchema;
  readonly: () => PassthroughSchema;
};

/** Build the (chainable) passthrough schema a strict codec must materialize. */
function makeSchema(): PassthroughSchema {
  const schema: PassthroughSchema = {
    parse: (value) => value,
    optional: () => schema,
    nonoptional: () => schema,
    nullable: () => schema,
    readonly: () => schema,
  };
  return schema;
}

const strict = {
  mode: 'strict' as const,
  typeSymbol: 'json',
  create: makeSchema,
  schema: makeSchema(),
};

function inputParam(name = 'input') {
  return { name, wire: name, source: 'json' as const, codec: strict };
}

function descriptor(method: string, params: any[] = []) {
  return {
    id: `@deepseek-kanban/plugin#kanban/${method}`,
    service: 'kanban',
    namespace: 'kanban',
    method,
    invocation: { kind: 'direct' as const },
    parameters: params,
    result: strict,
  };
}

export const KANBAN_REMOTE = {
  package: '@deepseek-kanban/plugin',
  descriptors: [
    descriptor('getPluginUpdateInfo'),
    descriptor('startPluginUpdate', [inputParam('input')]),
    descriptor('acknowledgePluginUpdate', [inputParam('input')]),
    descriptor('listProjects'),
    descriptor('getBoard'),
    descriptor('getTaskImage', [inputParam('input')]),
    descriptor('listTaskSessions'),
    descriptor('listCreateTaskOptions'),
    descriptor('listBranches', [inputParam('input')]),
    descriptor('listProjectPaths', [inputParam('input')]),
    descriptor('createTask', [inputParam('input')]),
    descriptor('moveTask', [inputParam('input')]),
    descriptor('approveTask', [inputParam('input')]),
    descriptor('resumeTask', [inputParam('input')]),
    descriptor('commentTask', [inputParam('input')]),
    descriptor('deleteTask', [inputParam('input')]),
  ],
};
