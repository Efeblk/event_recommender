export type InputInterpreter = 'rules' | 'jev-v1' | 'span-v2';
export type InputReader = 'fields' | 'v3';

/** The structured span parser is the default whenever Jev is configured. It
 * cannot read requests without Jev, so it falls back to the rules interpreter,
 * which needs no provider. */
export function inputInterpreterFrom(
  env: { INPUT_INTERPRETER?: string },
  jevConfigured: boolean,
): InputInterpreter {
  const configured = env.INPUT_INTERPRETER?.trim() || 'span-v2';
  if (
    configured !== 'rules' &&
    configured !== 'jev-v1' &&
    configured !== 'span-v2'
  )
    throw new Error('Invalid input interpreter configuration.');
  return configured === 'span-v2' && !jevConfigured ? 'rules' : configured;
}

export function inputReaderFrom(env: { INPUT_READER?: string }): InputReader {
  const configured = env.INPUT_READER?.trim() || 'v3';
  if (configured !== 'fields' && configured !== 'v3')
    throw new Error('Invalid input reader configuration.');
  return configured;
}
