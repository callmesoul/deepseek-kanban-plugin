/**
 * Hand-written Typert Remote contribution for the `kanban` namespace.
 *
 * The host service is discovered by the gateway's SRC fallback (the
 * `TypertRemoteService` binding + `@Remote` markers in `lib/index.js`), which
 * derives wire argument keys from the host method parameter names. The wire
 * keys here MUST therefore match those parameter names exactly (`input`).
 *
 * Strict codecs are required by the client mount; we use a passthrough schema
 * (the host SRC path already treats values as loose JSON, and the boundary is
 * a trusted in-process bridge) so the client bundle does not need zod.
 */
const passthrough = { parse: (value: unknown) => value };

const strict = { mode: 'strict', typeSymbol: 'json', schema: passthrough } as const;

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
    descriptor('listProjects'),
    descriptor('getBoard'),
    descriptor('listCreateTaskOptions'),
    descriptor('listBranches', [inputParam('input')]),
    descriptor('createTask', [inputParam('input')]),
    descriptor('moveTask', [inputParam('input')]),
    descriptor('approveTask', [inputParam('input')]),
    descriptor('resumeTask', [inputParam('input')]),
    descriptor('commentTask', [inputParam('input')]),
    descriptor('deleteTask', [inputParam('input')]),
  ],
};
