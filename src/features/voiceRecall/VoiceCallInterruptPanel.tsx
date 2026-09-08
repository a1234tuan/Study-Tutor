/**
 * 通话活动采集时系统返回的确认面板（§4.3）。
 *
 * 当用户在采集/播放活动时试图离开通话页或系统返回时弹出，三选一：
 * - 继续通话：留在通话页，恢复采集（由用户明确继续，§14）
 * - 暂停并离开：暂停采集/播放，保留会话检查点，返回来源页（卸载 ≠ 结束）
 * - 结束通话：结束整场会话，释放麦克风/连接/播放器与临时音频
 *
 * 纯展示组件；状态与副作用由调用方（VoiceRecallRuntimeController）持有。文字经 uiError 约束，
 * 不暴露 Provider 原始响应或密钥。
 */

interface VoiceCallInterruptPanelProps {
  open: boolean;
  onContinue: () => void;
  onPauseLeave: () => void;
  onEndCall: () => void;
}

export const VoiceCallInterruptPanel = ({
  open,
  onContinue,
  onPauseLeave,
  onEndCall,
}: VoiceCallInterruptPanelProps) => {
  if (!open) return null;
  return (
    <div className="voice-call-interrupt" role="dialog" aria-modal="true" aria-label="通话中断确认">
      <div className="voice-call-interrupt__sheet">
        <h2 className="voice-call-interrupt__title">通话进行中</h2>
        <p className="voice-call-interrupt__hint">采集或播放正在进行，请选择如何处理当前通话。</p>
        <div className="voice-call-interrupt__actions">
          <button type="button" className="primary-button" onClick={onContinue}>继续通话</button>
          <button type="button" className="secondary-button" onClick={onPauseLeave}>暂停并离开</button>
          <button type="button" className="danger-button" onClick={onEndCall}>结束通话</button>
        </div>
      </div>
      <style>{CSS}</style>
    </div>
  );
};

const CSS = `
.voice-call-interrupt{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;z-index:50}
.voice-call-interrupt__sheet{width:100%;max-width:480px;background:var(--color-surface,#fbfaf7);border-radius:16px 16px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:12px}
.voice-call-interrupt__title{margin:0;font-size:18px}
.voice-call-interrupt__hint{margin:0;font-size:14px;color:var(--color-text-muted,#7a726b)}
.voice-call-interrupt__actions{display:flex;flex-direction:column;gap:8px}
.voice-call-interrupt__actions button{padding:14px;font-size:15px;min-height:44px}
@media (prefers-reduced-motion: reduce){.voice-call-interrupt__sheet{transition:none}}
`;
