export class ExtensionPageMenus<K extends string> {
	constructor(
		private readonly prefix: string,
		private readonly ids: K[],
	) { prefix += '.' }

	register({
		title = (id: K) => id as string,
		documentUrlPatterns = undefined as string[] | undefined,
		contexts = [
			'image', 'link', 'page', 'selection'
		] as browser.menus.ContextType[],
	} = {}) {
		return this.ids.map(id => browser.menus.create({
			id: `${this.prefix}${id}`,
			title: title(id),
			documentUrlPatterns, contexts,
		}))
	}

	private static readonly menuEventUsed = new WeakSet<MouseEvent>()

	listen(
		selector: string,
		handler: { [id in K]: (this: Element) => unknown },
		statusLoader: (this: Element) => { [id in K]?: {
			visible?: boolean, enabled?: boolean
		} } = () => ({})
	) {
		document.addEventListener('contextmenu', event => {
			if (ExtensionPageMenus.menuEventUsed.has(event)) return
			let { target } = event
			if (target instanceof SVGElement && target.ownerSVGElement)
				target = target.ownerSVGElement
			const element = (target as HTMLElement).closest(selector)
			if (element) {
				browser.menus.overrideContext({ showDefaults: false })
				const status = statusLoader.call(element)
				for (const id of this.ids) {
					const { visible = true, enabled = true } = (status[id] || {})!
					browser.menus.update(`${this.prefix}${id}`, { visible, enabled })
				}
				ExtensionPageMenus.menuEventUsed.add(event)
			} else {
				for (const id of this.ids)
					browser.menus.update(`${this.prefix}${id}`, { visible: false })
			}
			browser.menus.refresh()
		}, { capture: true })

		browser.menus.onClicked.addListener(info => {
			if (typeof info.menuItemId !== 'string' ||
				!info.menuItemId.startsWith(this.prefix) ||
				info.targetElementId === undefined) return
			const id = info.menuItemId.slice(this.prefix.length) as K
			if (!this.ids.includes(id)) return
			const target = browser.menus.getTargetElement(info.targetElementId)
			if (!target || !(target instanceof Element)) return
			const t2 = target instanceof SVGElement && target.ownerSVGElement ?
				target.ownerSVGElement : target
			const element = t2.closest(selector)
			if (!element) return
			handler[id].call(element)
		})
	}

	static preventDefault() {
		document.addEventListener('contextmenu', event => {
			if (ExtensionPageMenus.menuEventUsed.has(event)) return
			event.preventDefault()
		})
	}
}