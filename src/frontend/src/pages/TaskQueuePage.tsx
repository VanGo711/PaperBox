import { CircleCheck, CircleX, Clock3, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface BackgroundTask {
  id: string;
  type: string;
  title: string;
  state: string;
  stage: string;
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequested?: boolean;
  error?: string;
}

const activeStates = new Set(['queued', 'processing', 'cancelling']);

function stateCopy(task: BackgroundTask) {
  const labels: Record<string, string> = { queued: '等待中', processing: '执行中', cancelling: '正在停止', completed: '已完成', cancelled: '已停止', failed: '失败' };
  return labels[task.state] ?? task.state;
}

function stateIcon(task: BackgroundTask) {
  if (task.state === 'completed') return <CircleCheck size={15} />;
  if (task.state === 'failed' || task.state === 'cancelled') return <CircleX size={15} />;
  if (task.state === 'queued') return <Clock3 size={15} />;
  return <LoaderCircle className="spin" size={15} />;
}

function formattedTime(value?: number) {
  return value ? new Date(value * 1_000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
}

function taskStage(task: BackgroundTask) {
  if (task.state === 'failed' && task.error) return task.error;
  return task.stage || '等待调度';
}

export function TaskQueuePage() {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch('/api/tasks');
      const payload = await response.json() as { tasks?: BackgroundTask[]; detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? '任务队列读取失败。');
      setTasks(payload.tasks ?? []);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务队列读取失败。');
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 1_500);
    return () => window.clearInterval(timer);
  }, [load]);

  const stopTask = async (task: BackgroundTask) => {
    setStopping(task.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' });
      const payload = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? '停止任务失败。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '停止任务失败。');
    } finally {
      setStopping(null);
    }
  };

  const activeCount = tasks.filter((task) => activeStates.has(task.state)).length;
  const completedCount = tasks.filter((task) => task.state === 'completed').length;
  const problemCount = tasks.filter((task) => task.state === 'failed' || task.state === 'cancelled').length;
  return <div className="task-queue-page">
    <header className="task-queue-toolbar"><div className="task-queue-heading"><strong>任务队列</strong><small>{activeCount ? `${activeCount} 个任务进行中` : '当前没有执行中的后台任务'}</small></div><div className="task-queue-toolbar-actions"><div className="task-queue-summary" aria-label="任务状态概览"><span className="active"><i />进行中 <b>{activeCount}</b></span><span className="completed"><i />已完成 <b>{completedCount}</b></span><span className="problem"><i />异常或停止 <b>{problemCount}</b></span></div><button type="button" title="刷新任务队列" aria-label="刷新任务队列" disabled={refreshing} onClick={() => void load(true)}><RefreshCw className={refreshing ? 'spin' : ''} size={16} /></button></div></header>
    {error && <div className="task-queue-error" role="alert">{error}</div>}
    <div className="task-queue-table" role="table" aria-label="后台任务列表">
      <div className="task-queue-head" role="row"><span>任务</span><span>当前阶段</span><span>状态</span><span>创建时间</span><span aria-label="操作" /></div>
      {tasks.map((task) => <div className="task-queue-row" role="row" key={task.id}>
        <span className="task-queue-name"><b>{task.title}</b><small>{task.type}</small></span>
        <span className="task-queue-stage" title={taskStage(task)}><i className="task-stage-marker" />{taskStage(task)}</span>
        <span className={`task-queue-state ${task.state}`}>{stateIcon(task)}{stateCopy(task)}</span>
        <time>{formattedTime(task.createdAt)}</time>
        <span className="task-queue-action">{activeStates.has(task.state) && <button type="button" title="强制停止任务" aria-label={`强制停止任务：${task.title}`} disabled={stopping === task.id || task.state === 'cancelling'} onClick={() => void stopTask(task)}>{stopping === task.id ? <LoaderCircle className="spin" size={15} /> : <Square size={14} />}</button>}</span>
      </div>)}
      {!loading && !tasks.length && <div className="task-queue-empty">暂无后台任务</div>}
      {loading && <div className="task-queue-empty"><LoaderCircle className="spin" size={17} />正在读取任务队列...</div>}
    </div>
  </div>;
}
