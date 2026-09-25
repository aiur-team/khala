import type { BindingId } from '@khala/contracts/delivery/index';
import type { ReadResult } from '../composition/read.js';
import { renderInboxBatch } from '../mcp/result-postprocessor.js';
import { CliError } from './errors.js';
import { validBindingArgument, validIdentifier } from './validation.js';

export type ReadArguments = Readonly<{
  bindingId: BindingId | null;
  acknowledgeToken?: string;
}>;

export function parseReadArguments(args: readonly string[]): ReadArguments {
  let bindingId: BindingId | null = null;
  let acknowledgeToken: string | undefined;
  let sawBinding = false;
  let sawAcknowledgement = false;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === '--binding' && !sawBinding && validBindingArgument(value)) {
      bindingId = value;
      sawBinding = true;
      continue;
    }
    if (flag === '--ack' && !sawAcknowledgement && validIdentifier(value)) {
      acknowledgeToken = value;
      sawAcknowledgement = true;
      continue;
    }
    throw new CliError('invalid_arguments');
  }

  return {
    bindingId,
    ...(acknowledgeToken === undefined ? {} : { acknowledgeToken }),
  };
}

export function renderReadOutput(result: ReadResult): string {
  return result.kind === 'empty'
    ? JSON.stringify({ ok: true, kind: 'empty' })
    : renderInboxBatch(result.batch);
}
