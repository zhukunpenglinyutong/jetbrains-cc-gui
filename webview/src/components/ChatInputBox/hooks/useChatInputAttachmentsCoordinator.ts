import { useState } from 'react';
import type { Attachment } from '../types.js';
import { useAttachmentHandlers } from './useAttachmentHandlers.js';
import { useAttachmentPersistence } from './useAttachmentPersistence.js';

interface UseChatInputAttachmentsCoordinatorOptions {
  externalAttachments: Attachment[] | undefined;
  onAddAttachment?: (files: FileList) => void;
  onRemoveAttachment?: (id: string) => void;
}

export function useChatInputAttachmentsCoordinator({
  externalAttachments,
  onAddAttachment,
  onRemoveAttachment,
}: UseChatInputAttachmentsCoordinatorOptions) {
  const [internalAttachments, setInternalAttachments] = useState<Attachment[]>([]);
  const attachments = externalAttachments ?? internalAttachments;

  const { clearDraft: clearAttachmentsDraft } = useAttachmentPersistence({
    attachments: internalAttachments,
    isControlled: externalAttachments !== undefined,
    onRestore: setInternalAttachments,
  });

  const { handleAddAttachment, handleRemoveAttachment } = useAttachmentHandlers({
    externalAttachments,
    onAddAttachment,
    onRemoveAttachment,
    setInternalAttachments,
  });

  return {
    attachments,
    internalAttachments,
    setInternalAttachments,
    clearAttachmentsDraft,
    handleAddAttachment,
    handleRemoveAttachment,
  };
}
