import { onBeforeUnmount, watch, type Ref } from 'vue'

/** Keep keyboard navigation within a mounted dialog and return to its trigger. */
export function useDialogFocus(dialog: Ref<HTMLElement | undefined>) {
  const stop = watch(dialog, (node, _oldNode, onCleanup) => {
    if (!node) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = () => Array.from(node.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') &&
      !element.closest('[inert]') && element.getClientRects().length > 0)

    function keyboard(event: KeyboardEvent) {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const items = controls(), first = items[0], last = items.at(-1)
      const current = document.activeElement
      if (!first) { event.preventDefault(); node!.focus({ preventScroll: true }); return }
      if (event.shiftKey && (current === first || current === node)) {
        event.preventDefault(); last?.focus({ preventScroll: true })
      } else if (!event.shiftKey && (current === last || current === node)) {
        event.preventDefault(); first.focus({ preventScroll: true })
      }
    }

    node.addEventListener('keydown', keyboard)
    const initial = controls()[0] || node
    initial.focus({ preventScroll: true })
    onCleanup(() => {
      node.removeEventListener('keydown', keyboard)
      if (previous?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true })
      }
    })
  }, { flush: 'post' })
  onBeforeUnmount(stop)
}
