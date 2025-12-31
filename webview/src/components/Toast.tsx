import React, { useEffect, useState } from 'react';

export interface ToastMessage {
  id: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
}

interface ToastProps {
  message: ToastMessage;
  onDismiss: (id: string) => void;
  duration?: number;
}

const Toast: React.FC<ToastProps> = ({ message, onDismiss, duration = 1000 }) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(() => onDismiss(message.id), 300); // Wait for exit animation
    }, duration);

    return () => clearTimeout(timer);
  }, [message.id, duration, onDismiss]);

  return (
    <div className={`toast toast-${message.type || 'info'} ${isExiting ? 'toast-exit' : ''}`}>
      <div className="toast-content">
        <span className="toast-message">{message.message}</span>
        <button
          className="toast-close"
          onClick={() => {
            setIsExiting(true);
            setTimeout(() => onDismiss(message.id), 300);
          }}
        >
          <span className="codicon codicon-close" />
        </button>
      </div>
    </div>
  );
};

interface ToastContainerProps {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ messages, onDismiss }) => {
  return (
    <div className="toast-container">
      {messages.map((msg) => (
        <Toast key={msg.id} message={msg} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

