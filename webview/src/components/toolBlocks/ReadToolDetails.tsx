import type { ToolResultImage } from '../../utils/toolResultImages';

const TASK_DETAILS_STYLE: React.CSSProperties = {
  padding: '12px',
  border: 'none',
};

const PARAMS_CONTAINER_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontSize: '12px',
};

const PARAM_ROW_STYLE: React.CSSProperties = {
  color: '#858585',
  display: 'flex',
  alignItems: 'baseline',
  overflow: 'hidden',
};

const PARAM_KEY_STYLE: React.CSSProperties = {
  color: '#90caf9',
  fontWeight: 600,
  flexShrink: 0,
};

const PARAM_VALUE_STYLE: React.CSSProperties = {
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  flex: 1,
};

const RESULT_IMAGE_STYLE: React.CSSProperties = {
  maxWidth: '100%',
  maxHeight: '300px',
  borderRadius: '4px',
  objectFit: 'contain',
};

interface ReadToolDetailsProps {
  params: [string, unknown][];
  resultImages: ToolResultImage[];
}

const ReadToolDetails = function ReadToolDetails({ params, resultImages }: ReadToolDetailsProps) {
  return (
    <div className="task-details" style={TASK_DETAILS_STYLE}>
      <div style={PARAMS_CONTAINER_STYLE}>
        {params.map(([key, value]) => (
          <div key={key} style={PARAM_ROW_STYLE}>
            <span style={PARAM_KEY_STYLE}>{key}：</span>
            <span style={PARAM_VALUE_STYLE}>
              {String(value)}
            </span>
          </div>
        ))}
        {resultImages.map((image, idx) => (
          <img
            key={`result-image-${idx}`}
            src={image.src}
            alt={image.mediaType ?? 'image'}
            style={RESULT_IMAGE_STYLE}
          />
        ))}
      </div>
    </div>
  );
};

export default ReadToolDetails;
