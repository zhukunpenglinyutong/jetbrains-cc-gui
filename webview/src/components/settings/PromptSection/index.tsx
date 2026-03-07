import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptConfig, PromptScope } from '../../../types/prompt';
import { usePromptManagement } from '../hooks/usePromptManagement';
import PromptScopeSection from './PromptScopeSection';
import PromptDialog from '../../PromptDialog';
import ConfirmDialog from '../../ConfirmDialog';
import PromptExportDialog from './PromptExportDialog';
import PromptImportConfirmDialog from './PromptImportConfirmDialog';
import styles from './style.module.less';

interface PromptSectionProps {
  onSuccess?: (message: string) => void;
}

export default function PromptSection({
  onSuccess,
}: PromptSectionProps) {
  const { t } = useTranslation();

  // Use prompt management hook
  const {
    globalPrompts,
    projectPrompts,
    projectInfo,
    promptsLoading,
    promptDialog,
    deletePromptConfirm,
    importPreviewDialog,
    exportDialog,
    loadAllPrompts,
    updateGlobalPrompts,
    updateProjectPrompts,
    updateProjectInfo,
    handleAddPrompt,
    handleEditPrompt,
    handleClosePromptDialog,
    handleDeletePrompt,
    handleSavePrompt,
    confirmDeletePrompt,
    cancelDeletePrompt,
    handlePromptOperationResult,
    handleExportPrompts,
    handleCloseExportDialog,
    handleConfirmExport,
    handleImportPromptsFile,
    handlePromptImportPreviewResult,
    handleCloseImportPreview,
    handleSaveImportedPrompts,
    handlePromptImportResult,
    cleanupPromptsTimeout,
  } = usePromptManagement({ onSuccess });

  // Load prompts on mount
  useEffect(() => {
    loadAllPrompts();
    return () => cleanupPromptsTimeout();
  }, [loadAllPrompts, cleanupPromptsTimeout]);

  // Setup window callbacks
  useEffect(() => {
    window.updateGlobalPrompts = (json: string) => {
      try {
        const promptsList = JSON.parse(json);
        updateGlobalPrompts(promptsList);
      } catch (error) {
        console.error('[PromptSection] Failed to parse global prompts:', error);
      }
    };

    window.updateProjectPrompts = (json: string) => {
      try {
        const promptsList = JSON.parse(json);
        updateProjectPrompts(promptsList);
      } catch (error) {
        console.error('[PromptSection] Failed to parse project prompts:', error);
      }
    };

    window.updateProjectInfo = (json: string) => {
      try {
        const info = JSON.parse(json);
        updateProjectInfo(info);
      } catch (error) {
        console.error('[PromptSection] Failed to parse project info:', error);
      }
    };

    window.handlePromptOperationResult = (json: string) => {
      try {
        const result = JSON.parse(json);
        handlePromptOperationResult(result);
      } catch (error) {
        console.error('[PromptSection] Failed to parse prompt operation result:', error);
      }
    };

    window.handlePromptImportPreviewResult = (json: string) => {
      try {
        const previewData = JSON.parse(json);
        handlePromptImportPreviewResult(previewData);
      } catch (error) {
        console.error('[PromptSection] Failed to parse prompt import preview result:', error);
      }
    };

    window.handlePromptImportResult = (json: string) => {
      try {
        const result = JSON.parse(json);
        handlePromptImportResult(result);
      } catch (error) {
        console.error('[PromptSection] Failed to parse prompt import result:', error);
      }
    };

    return () => {
      delete window.updateGlobalPrompts;
      delete window.updateProjectPrompts;
      delete window.updateProjectInfo;
      delete window.handlePromptOperationResult;
      delete window.handlePromptImportPreviewResult;
      delete window.handlePromptImportResult;
    };
  }, [
    updateGlobalPrompts,
    updateProjectPrompts,
    updateProjectInfo,
    handlePromptOperationResult,
    handlePromptImportPreviewResult,
    handlePromptImportResult,
  ]);

  // Copy to global handler
  const handleCopyToGlobal = useCallback((_prompt: PromptConfig) => {
    // Create a copy without the scope field
    // const { scope: _scope, ...promptData } = prompt;
    // Open add dialog for global scope with pre-filled data
    handleAddPrompt('global');
    // The dialog will need to be enhanced to accept initial data
    // For now, this opens an empty dialog - TODO: enhance PromptDialog to accept initialData
  }, [handleAddPrompt]);

  // Get all prompts for export dialog (combining global and project based on export scope)
  const getPromptsForExport = (scope: PromptScope) => {
    return scope === 'global' ? globalPrompts : projectPrompts;
  };

  return (
    <div className={styles.promptLibrary}>
      <h3>{t('settings.prompt.title')}</h3>
      <p className={styles.description}>{t('settings.prompt.description')}</p>

      {/* Global Prompts Section */}
      <PromptScopeSection
        title={t('settings.prompt.global')}
        scope="global"
        prompts={globalPrompts}
        loading={promptsLoading}
        onAdd={() => handleAddPrompt('global')}
        onEdit={(prompt) => handleEditPrompt(prompt, 'global')}
        onDelete={(prompt) => handleDeletePrompt(prompt, 'global')}
        onExport={() => handleExportPrompts('global')}
        onImport={() => handleImportPromptsFile('global')}
      />

      {/* Project Prompts Section */}
      {projectInfo?.available ? (
        <PromptScopeSection
          title={t('settings.prompt.projectScope', { projectName: projectInfo.name })}
          scope="project"
          prompts={projectPrompts}
          loading={promptsLoading}
          showCopyToGlobal={true}
          onAdd={() => handleAddPrompt('project')}
          onEdit={(prompt) => handleEditPrompt(prompt, 'project')}
          onDelete={(prompt) => handleDeletePrompt(prompt, 'project')}
          onExport={() => handleExportPrompts('project')}
          onImport={() => handleImportPromptsFile('project')}
          onCopyToGlobal={handleCopyToGlobal}
        />
      ) : (
        <div className={styles.noProject}>
          <p>{t('settings.prompt.noProject')}</p>
        </div>
      )}

      {/* Prompt add/edit dialog */}
      <PromptDialog
        isOpen={promptDialog.isOpen}
        prompt={promptDialog.prompt}
        onClose={handleClosePromptDialog}
        onSave={handleSavePrompt}
      />

      {/* Prompt delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deletePromptConfirm.isOpen}
        title={t('settings.prompt.deleteConfirmTitle')}
        message={t('settings.prompt.deleteConfirmMessage', { name: deletePromptConfirm.prompt?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeletePrompt}
        onCancel={cancelDeletePrompt}
      />

      {/* Prompt export dialog */}
      {exportDialog.isOpen && (
        <PromptExportDialog
          prompts={getPromptsForExport(exportDialog.scope)}
          onConfirm={handleConfirmExport}
          onCancel={handleCloseExportDialog}
        />
      )}

      {/* Prompt import preview dialog */}
      {importPreviewDialog.isOpen && importPreviewDialog.previewData && (
        <PromptImportConfirmDialog
          previewData={importPreviewDialog.previewData}
          onConfirm={(selectedIds, strategy) => handleSaveImportedPrompts(selectedIds, strategy, importPreviewDialog.scope)}
          onCancel={handleCloseImportPreview}
        />
      )}
    </div>
  );
}
