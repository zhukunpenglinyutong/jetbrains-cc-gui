import styles from './style.module.less';

const CommunitySection = () => {
  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>官方交流群</h3>
      <p className={styles.sectionDesc}>扫描下方二维码加入官方微信交流群，获取最新资讯和技术支持</p>

      <div className={styles.qrcodeContainer}>
        <div className={styles.qrcodeWrapper}>
          <img
            src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/vscode/wxq.png"
            alt="官方微信交流群二维码"
            className={styles.qrcodeImage}
          />
          <p className={styles.qrcodeTip}>使用微信扫一扫加入交流群</p>
        </div>
      </div>
    </div>
  );
};

export default CommunitySection;
