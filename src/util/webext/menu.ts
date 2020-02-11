import { unreachable } from "../error.js"

export class ExtensionPageMenus<K extends string, S extends string> {
	private readonly allIds: (K | S)[]
	constructor(
		private readonly prefix: string,
		private readonly ids: K[],
		private readonly subIds: S[],
	) {
		this.prefix += '.'
		this.allIds = [...this.ids, ...this.subIds]
	}

	register({
		title = (id: K | S) => id as string,
		documentUrlPatterns = undefined as string[] | undefined,
		contexts = [
			'image', 'link', 'page', 'selection'
		] as browser.menus.ContextType[],
	} = {}) {
		return this.allIds.map(id => browser.menus.create({
			id: `${this.prefix}${id}`,
			title: title(id),
			parentId: id.includes('.') ?
				this.prefix + id.replace(/(.*)\..*/, '$1') : undefined,
			documentUrlPatterns, contexts,
		}))
	}

	private static readonly menuEventUsed = new WeakSet<MouseEvent>()

	listen(
		selector: string,
		handler: { [id in K]: (this: Element, subId: string[]) => unknown },
		statusLoader: (this: Element) => { [id in K | S]?: {
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
			const id = info.menuItemId.slice(this.prefix.length) as K | S
			if (!this.allIds.includes(id)) return
			const target = browser.menus.getTargetElement(info.targetElementId)
			if (!target || !(target instanceof Element)) return
			const t2 = target instanceof SVGElement && target.ownerSVGElement ?
				target.ownerSVGElement : target
			const element = t2.closest(selector)
			if (!element) return

			const split = id.split('.'), subIds: string[] = []
			while (split.length) {
				const key = split.join('.')
				if (key in handler) {
					handler[key as K].call(element, subIds)
					return
				}
				subIds.unshift(split.pop()!)
			}
			unreachable()
		})
	}

	static preventDefault() {
		document.addEventListener('contextmenu', event => {
			if (ExtensionPageMenus.menuEventUsed.has(event)) return
			event.preventDefault()
		})
	}
}