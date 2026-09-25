// Versioned internal channel lifecycle API. Launcher, channel-access and
// Make External work consume these entry points; none of them reconstructs a
// channel directory or reads store tables directly.

export { CHANNELS_DIRECTORY, channelDirectory, channelDirectorySegment, isLifecycleChannelId } from './paths';
export {
  type LifecycleOpenFailure, type LifecycleOpenFailureCode, type ResumeResultV1, resumeInternalChannel,
} from './resume';
export {
  type ExportFailureCode, type ExportFormat, type ExportOverwrite, type ExportResultV1,
  JSONL_EXPORT_FORMAT_V1, MARKDOWN_EXPORT_FORMAT_V1, exportInternalChannel, renderJsonl, renderMarkdown,
} from './export';
export {
  type DeleteConfirmationV1, type DeleteFailureCode, type DeleteResultV1,
  PLAINTEXT_DELETION_NOTICE, deleteConfirmation, deleteInternalChannel,
} from './delete';
export {
  type ArchiveEvent, type ArchiveParticipant, type ArchiveSnapshot, type ResumeMetadataV1,
  LIFECYCLE_CHANNEL_META_KEY, bindLifecycleChannel,
} from '../store/lifecycle-snapshot';
