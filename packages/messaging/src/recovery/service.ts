import type {
  CallOptions, OperationResult, OwnerId, ProvideRecoverySecret, RecoveryPort, RecoveryRejection, RecoveryStatus,
} from '@khala/contracts/messaging/index';
import { rejected, unavailable } from '@khala/contracts/messaging/index';
import { projectCapabilities, type RecoveryIdentity } from './capabilities';

export type RecoveryServiceDeps = Readonly<{
  ownerId: OwnerId;
  identity: RecoveryIdentity;
}>;

export interface RecoveryService extends RecoveryPort {
  begin(
    input: Readonly<{ operationId: string; mode: string }>,
    provideSecret: ProvideRecoverySecret,
    options?: CallOptions,
  ): Promise<OperationResult<RecoveryStatus, RecoveryRejection>>;
  inspect(operationId: string, options?: CallOptions): Promise<OperationResult<RecoveryStatus, 'not_found'>>;
}

export function createRecoveryService(deps: RecoveryServiceDeps): RecoveryService {
  async function capabilities(options?: CallOptions) {
    return (await projectCapabilities(deps.ownerId, deps.identity, options)).capabilities;
  }

  return {
    capabilities,
    async begin(_input, _provideSecret, options) {
      if (options?.signal?.aborted) return unavailable();
      return rejected('unsupported_mode');
    },
    async inspect(_operationId, options) {
      if (options?.signal?.aborted) return unavailable();
      return rejected('not_found');
    },
  };
}
