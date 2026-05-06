import type { ReactNode } from 'react';
import styles from './style.module.less';

interface AiFeatureSettingsCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  testId?: string;
}

const AiFeatureSettingsCard = ({
  title,
  description,
  children,
  testId,
}: AiFeatureSettingsCardProps) => {
  return (
    <section className={styles.cardSection} data-testid={testId}>
      <div className={styles.header}>
        <h3 className={styles.title}>{title}</h3>
        {description && <p className={styles.description}>{description}</p>}
      </div>
      <div className={styles.cardBody}>
        {children}
      </div>
    </section>
  );
};

export default AiFeatureSettingsCard;
