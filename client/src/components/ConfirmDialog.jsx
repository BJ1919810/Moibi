import { useEffect } from 'react';

/** 通用确认弹窗：替代 window.confirm，支持 Esc / 点击遮罩取消 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal modal--confirm" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">{title}</h3>
        {message && <p className="modal__hint">{message}</p>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>{cancelText}</button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
