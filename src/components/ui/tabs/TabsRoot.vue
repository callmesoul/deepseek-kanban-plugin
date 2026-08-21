<script setup lang="ts">
import type { TabsRootProps } from 'reka-ui'
import { TabsRoot } from 'reka-ui'

const props = defineProps<TabsRootProps>()
</script>

<template>
  <TabsRoot v-bind="props">
    <slot />
  </TabsRoot>
</template>
