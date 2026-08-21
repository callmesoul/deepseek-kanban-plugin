<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { TabsContent } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <TabsContent
    v-bind="delegatedProps"
    :class="cn('min-h-0 outline-none', props.class)"
  >
    <slot />
  </TabsContent>
</template>
