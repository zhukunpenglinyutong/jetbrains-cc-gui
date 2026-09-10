import { formatParamValue } from '../../utils/helpers';
import type { ToolResultImage } from '../../utils/toolResultImages';
import { RESULT_IMAGE_STYLE } from './genericToolStyles';

/** Cap rendered param values so a huge Write `content` param (tens of KB) never lands in the DOM. */
const MAX_PARAM_VALUE_CHARS = 4000;

const formatParamValueCapped = (value: unknown): string => {
  const text = formatParamValue(value);
  if (text.length <= MAX_PARAM_VALUE_CHARS) return text;
  return `${text.slice(0, MAX_PARAM_VALUE_CHARS)}… (+${text.length - MAX_PARAM_VALUE_CHARS} more chars)`;
};

interface ToolDetailsAccordionProps {
  expanded: boolean;
  otherParams: [string, unknown][];
  resultImages: ToolResultImage[];
}

const ToolDetailsAccordion = ({ expanded, otherParams, resultImages }: ToolDetailsAccordionProps) => (
  <div className={`task-details-accordion ${expanded ? 'expanded' : ''}`}>
    <div className="task-details">
      <div className="task-content-wrapper">
        {otherParams.map(([key, value]) => (
          <div key={key} className="task-field">
            <div className="task-field-label">{key}</div>
            <div className="task-field-content">{formatParamValueCapped(value)}</div>
          </div>
        ))}
        {/* Only mount the (potentially large base64) images while expanded */}
        {expanded && resultImages.map((image, idx) => (
          <div key={`result-image-${idx}`} className="task-field">
            <img src={image.src} alt={image.mediaType ?? 'image'} style={RESULT_IMAGE_STYLE} />
          </div>
        ))}
      </div>
    </div>
  </div>
);

export default ToolDetailsAccordion;
