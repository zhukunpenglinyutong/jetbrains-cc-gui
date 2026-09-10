interface QuestionOptionRowProps {
  label: string;
  description: string;
  isSelected: boolean;
  multiSelect: boolean;
  className?: string;
  onToggle: () => void;
}

const QuestionOptionRow = ({
  label,
  description,
  isSelected,
  multiSelect,
  className = '',
  onToggle,
}: QuestionOptionRowProps) => {
  return (
    <button
      className={`question-option ${className} ${isSelected ? 'selected' : ''}`.trim()}
      onClick={onToggle}
    >
      <div className="option-checkbox">
        {multiSelect ? (
          <span className={`codicon codicon-${isSelected ? 'check' : 'blank'}`} />
        ) : (
          <span className={`codicon codicon-${isSelected ? 'circle-filled' : 'circle-outline'}`} />
        )}
      </div>
      <div className="option-content">
        <div className="option-label">{label}</div>
        <div className="option-description">{description}</div>
      </div>
    </button>
  );
};

export default QuestionOptionRow;
