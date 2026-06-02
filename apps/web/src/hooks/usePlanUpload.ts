'use client';

import { useCallback, useRef, useState } from 'react';
import {
  api, ApiError, formatApiError, resolveMime, S3UploadError, uploadToS3,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { maskUrl, uploadLog } from '@/lib/upload-log';
import {
  INITIAL_TIMELINE, TimelineState, TimelineStepId,
} from '@/components/upload/ProcessingTimeline';

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 60_000;

export type UploadSession = {
  fileName: string;
  assetId?: string;
  jobId?: string;
  status: 'idle' | 'uploading' | 'processing' | 'done' | 'failed';
  message?: string;
  failedStage?: string;
  timeline: TimelineState;
  startedAt?: number;
};

export type AssetProcessingStatus = {
  assetId: string;
  status: 'pending' | 'uploaded' | 'scanned' | 'rejected';
  projectId: string;
  processingComplete: boolean;
  floors: { id: string; name: string; analysisStatus?: string }[];
  allAnalysisDone: boolean;
};

function timelineAfterUploadQueued(): TimelineState {
  return {
    ...INITIAL_TIMELINE,
    upload: 'success',
    s3: 'success',
    complete: 'success',
    queue: 'success',
    processing: 'active',
    floors: 'pending',
    ai: 'pending',
  };
}

function timelineFromAssetStatus(asset: AssetProcessingStatus): TimelineState {
  const t = timelineAfterUploadQueued();
  const hasFloors = asset.floors.length > 0;

  if (asset.status === 'uploaded' && !hasFloors) {
    t.processing = 'active';
    return t;
  }

  if (asset.processingComplete || hasFloors) {
    t.processing = 'success';
    t.floors = 'success';
  }

  const statuses = asset.floors.map((f) => f.analysisStatus ?? 'none');
  const anyAi = statuses.some((s) => s !== 'none');
  const anyActive = statuses.some((s) => s === 'processing' || s === 'queued');
  const allDone = hasFloors && statuses.every((s) => s === 'done' || s === 'failed');

  if (anyAi || anyActive) t.ai = 'active';
  if (allDone) t.ai = statuses.some((s) => s === 'failed') ? 'failed' : 'success';

  return t;
}

function setStep(timeline: TimelineState, id: TimelineStepId, status: StepStatus): TimelineState {
  return { ...timeline, [id]: status };
}

type StepStatus = TimelineState[TimelineStepId];

export function usePlanUpload(projectId: string, onRefresh: () => Promise<void>) {
  const [session, setSession] = useState<UploadSession>({
    fileName: '',
    status: 'idle',
    timeline: INITIAL_TIMELINE,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiToastRef = useRef(false);
  const floorsToastRef = useRef(false);

  const clearPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
    aiToastRef.current = false;
    floorsToastRef.current = false;
  }, []);

  const pollProcessing = useCallback((assetId: string, jobId: string | undefined, fileName: string) => {
    clearPolling();
    aiToastRef.current = false;
    floorsToastRef.current = false;
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const [project, assetStatus] = await Promise.all([
          api.get<any>(`/projects/${projectId}`),
          api.get<AssetProcessingStatus>(`/assets/${assetId}/status`),
        ]);

        uploadLog('poll', {
          projectId,
          assetId,
          jobId,
          assetStatus: assetStatus.status,
          floors: assetStatus.floors.length,
        });

        const timeline = timelineFromAssetStatus(assetStatus);
        const floorCount = Math.max(project?.floors?.length ?? 0, assetStatus.floors.length);

        if (floorCount > 0 && !floorsToastRef.current) {
          floorsToastRef.current = true;
          toast.success(`Floor${floorCount > 1 ? 's' : ''} generated (${floorCount})`);
        }

        const anyAiActive = assetStatus.floors.some((f) =>
          f.analysisStatus === 'processing' || f.analysisStatus === 'queued',
        );
        if (anyAiActive && !aiToastRef.current) {
          aiToastRef.current = true;
          toast.info('AI analysis started');
        }

        if (assetStatus.allAnalysisDone) {
          clearPolling();
          await onRefresh();
          const anyFailed = assetStatus.floors.some((f) => f.analysisStatus === 'failed');
          setSession({
            fileName,
            assetId,
            jobId,
            status: anyFailed ? 'failed' : 'done',
            timeline,
            message: anyFailed
              ? 'Floors created, but some AI analysis steps failed.'
              : 'All floors processed and analyzed.',
            startedAt,
          });
          toast[anyFailed ? 'warning' : 'success'](
            anyFailed ? 'AI analysis completed with warnings' : 'AI analysis completed',
          );
          return;
        }

        setSession({
          fileName,
          assetId,
          jobId,
          status: 'processing',
          timeline,
          message: floorCount > 0
            ? 'Floors created — waiting for AI analysis…'
            : 'Waiting for worker to process your plan…',
          startedAt,
        });

        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
          clearPolling();
          await onRefresh();
          if (floorCount === 0) {
            const msg = 'Upload completed, but processing is still running or failed. Check worker status.';
            toast.warning(msg);
            setSession({
              fileName,
              assetId,
              jobId,
              status: 'failed',
              timeline: setStep(timeline, 'processing', 'failed'),
              message: msg,
              failedStage: 'Waiting for worker',
              startedAt,
            });
          }
        }
      } catch (err) {
        uploadLog('poll-error', { error: String(err) });
      }
    };

    void tick();
    pollRef.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    timeoutRef.current = setTimeout(clearPolling, POLL_TIMEOUT_MS + 1000);
  }, [clearPolling, onRefresh, projectId]);

  const upload = useCallback(async (file: File) => {
    clearPolling();
    const mime = resolveMime(file);
    let timeline: TimelineState = { ...INITIAL_TIMELINE };
    let toastId: string | number | undefined;

    setSession({
      fileName: file.name,
      status: 'uploading',
      message: 'Starting upload…',
      timeline,
      failedStage: undefined,
      startedAt: Date.now(),
    });

    try {
      timeline = setStep(timeline, 'upload', 'active');
      setSession((s) => ({ ...s, timeline, message: 'Requesting upload URL…' }));
      toastId = toast.loading('Requesting upload URL…');
      uploadLog('upload-url-request', { projectId, fileName: file.name, mime, sizeBytes: file.size });

      const uploadMeta = await api.post<{ assetId: string; uploadUrl: string }>(
        `/projects/${projectId}/floors/upload-url`,
        { fileName: file.name, mime, sizeBytes: file.size },
      );

      timeline = setStep(timeline, 'upload', 'success');
      timeline = setStep(timeline, 's3', 'active');
      setSession((s) => ({ ...s, timeline, assetId: uploadMeta.assetId, message: 'Upload URL received' }));
      toast.success('Upload URL received', { id: toastId });
      uploadLog('upload-url-response', { projectId, assetId: uploadMeta.assetId, uploadUrl: maskUrl(uploadMeta.uploadUrl) });

      toastId = toast.loading('Uploading file to S3…');
      setSession((s) => ({ ...s, message: 'Uploading file to S3…' }));
      uploadLog('s3-upload-start', { projectId, assetId: uploadMeta.assetId });

      await uploadToS3(uploadMeta.uploadUrl, file, mime);

      timeline = setStep(timeline, 's3', 'success');
      timeline = setStep(timeline, 'complete', 'active');
      toast.success('Upload to S3 completed', { id: toastId });
      uploadLog('s3-upload-done', { projectId, assetId: uploadMeta.assetId });

      toastId = toast.loading('Confirming upload with API…');
      setSession((s) => ({ ...s, timeline, message: 'Confirming upload with API…' }));

      const complete = await api.post<{ assetId: string; jobId: string; status: string }>(
        `/assets/${uploadMeta.assetId}/complete`,
      );

      timeline = timelineAfterUploadQueued();
      toast.success('Processing queued', { id: toastId });
      uploadLog('complete-response', {
        projectId,
        assetId: complete.assetId,
        jobId: complete.jobId,
        status: complete.status,
      });

      toast.info('Waiting for worker…');
      setSession({
        fileName: file.name,
        assetId: complete.assetId,
        jobId: complete.jobId,
        status: 'processing',
        timeline,
        message: 'Waiting for worker to process your plan…',
        startedAt: Date.now(),
      });

      pollProcessing(complete.assetId, complete.jobId, file.name);
    } catch (err) {
      const stage =
        err instanceof S3UploadError ? 'Uploading file to S3'
        : err instanceof ApiError && err.endpoint.includes('upload-url') ? 'Requesting upload URL'
        : err instanceof ApiError && err.endpoint.includes('complete') ? 'Confirming upload with API'
        : 'Upload';

      const message = formatApiError(err, stage);
      uploadLog('failed', { stage, error: err instanceof ApiError ? err.toLogObject() : String(err) });
      toast.error(message, toastId ? { id: toastId } : undefined);

      const failedStep: TimelineStepId | null =
        stage.includes('upload URL') ? 'upload'
        : stage.includes('S3') ? 's3'
        : stage.includes('Confirming') ? 'complete'
        : null;

      setSession((s) => ({
        ...s,
        status: 'failed',
        message,
        failedStage: stage,
        timeline: failedStep ? setStep(s.timeline, failedStep, 'failed') : s.timeline,
      }));
    }
  }, [clearPolling, pollProcessing, projectId]);

  return { session, upload, clearPolling };
}
