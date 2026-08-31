import { onBeforeUnmount, onMounted, readonly, ref } from 'vue';

/** DSH 由 ui-layout 将解析后的外观投影到 body 的这个属性上。 */
const DSH_DARK_THEME_ATTRIBUTE = 'data-ds-dark-theme';

function readDshDarkTheme(): boolean {
  return typeof document !== 'undefined'
    && document.body.hasAttribute(DSH_DARK_THEME_ATTRIBUTE);
}

/**
 * 跟随 DSH 当前实际生效的配色。
 *
 * DSH 会先把“跟随系统”解析成 light/dark，再更新 body 属性，因此这里无需
 * 重复读取用户设置或监听 prefers-color-scheme。
 */
export function useDshAppearance() {
  const isDark = ref(readDshDarkTheme());
  let observer: MutationObserver | null = null;

  onMounted(() => {
    const sync = () => {
      isDark.value = readDshDarkTheme();
    };

    sync();
    observer = new MutationObserver(sync);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [DSH_DARK_THEME_ATTRIBUTE],
    });
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return {
    isDark: readonly(isDark),
  };
}
