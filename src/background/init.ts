import { panelGroupMenus, groupColorCodesLight, groupColorCodesDark } from "../common/common.js";
import { M } from "../util/webext/i18n.js";
import { groupManager } from "./group-manager.js";
import { S, localSettings } from "./settings.js";

export { }

browser.runtime.onInstalled.addListener(({ reason, temporary }) => {
	if (reason === 'install' && !temporary)
		browser.tabs.create({ url: '/pages/first-install.html' });
})

const panelURL = new URL(browser.runtime.getManifest()
	.browser_action!.default_popup!)
panelURL.search = ''
panelGroupMenus.register({ title: M, documentUrlPatterns: [panelURL + '*'] })

const moveToGroupMenu = browser.menus.create({
	title: M.moveToGroup,
	contexts: ['tab'],
})
const moveToGroupSubMenus = new Map<string | number, string>()

browser.menus.onShown.addListener(async ({ menuIds }) => {
	if (!(menuIds as unknown[]).includes(moveToGroupMenu)) return
	for (const id of moveToGroupSubMenus.keys())
		browser.menus.remove(id)
	moveToGroupSubMenus.clear()
	for (const group of await groupManager.listGroups()) {
		const groupId = group.id
		if (group.state !== 'closed' || groupId === undefined) continue
		moveToGroupSubMenus.set(browser.menus.create({
			title: group.name, parentId: moveToGroupMenu,
			onclick: async (_, tab) => {
				await groupManager.appendGroup(groupId,
					[{ ...tab, active: false }])
				const tabs = await browser.tabs.query({ windowId: tab.windowId })
				if (tabs.length === 1 && tabs[0].id === tab.id)
					void browser.tabs.create({ windowId: tab.windowId })
				void browser.tabs.remove(tab.id!)
			}
		}), groupId)
	}
	browser.menus.update(moveToGroupMenu, { enabled: !!moveToGroupSubMenus.size })
	browser.menus.refresh()
})

const extraIconsSVG = fetch('/icons/extra-icons.svg').then(r => r.text())
	.then(s => new DOMParser().parseFromString(s, 'image/svg+xml')
		.documentElement as Element as SVGSVGElement)
const colorNormalizer = document.createElement('canvas').getContext('2d')!

groupManager.onWindowUpdate.listen(async ({ windowId, name, color }) => {
	browser.browserAction.setTitle({
		title: name === undefined ? M.extensionName :
			M('browserActionTitle', name, M.extensionName),
		windowId,
	})

	let themeColorCode: string | undefined
	try {
		const { colors } = await browser.theme.getCurrent(windowId)
		if (colors) {
			const c = colors.icons || colors.toolbar_text || colors.bookmark_text
			themeColorCode = Array.isArray(c) ?
				`${'rgba'.slice(0, c.length)}(${c.join(',')})` : c
		}
	} catch { }

	let isDark: boolean | undefined
	if (themeColorCode) try {
		colorNormalizer.fillStyle = themeColorCode
		if (colorNormalizer.fillStyle.startsWith('#'))
			colorNormalizer.fillStyle += '7f' // force rgba
		const [r, g, b] = colorNormalizer.fillStyle.replace('rgba(', '')
			.split(',', 3).map(Number)
		// https://en.wikipedia.org/wiki/YIQ
		isDark = (r * 299 + g * 587 + b * 114) >= 128000
	} catch { }
	if (isDark === undefined)
		isDark = matchMedia('(prefers-color-scheme: dark)').matches
	const colorCode = (isDark ? groupColorCodesDark : groupColorCodesLight)
		.get(color)!

	const SIZE_PX = 16
	const size = Math.ceil(SIZE_PX * devicePixelRatio)
	const img = new Image(size, size)
	const node = (await extraIconsSVG).cloneNode(true) as SVGSVGElement
	const symbol = node.getElementById(S.toolbarIcon)
	node.setAttribute('viewBox', symbol.getAttribute('viewBox')!)
	node.innerHTML = symbol.innerHTML
	node.style.color = colorCode
	node.setAttribute('width', '' + size)
	node.setAttribute('height', '' + size)
	await new Promise(resolve => {
		img.addEventListener('load', resolve)
		img.src = "data:image/svg+xml," + encodeURIComponent(node.outerHTML)
	})
	img.width = size
	img.height = size

	const canvas = document.createElement('canvas')
	canvas.width = size
	canvas.height = size
	const context = canvas.getContext('2d')!
	context.imageSmoothingEnabled = false
	context.drawImage(img, 0, 0)
	browser.browserAction.setIcon({
		windowId,
		imageData: { [SIZE_PX]: context.getImageData(0, 0, size, size) }
	})
})
// no need to refresh on browser start
localSettings.listen('toolbarIcon', () => groupManager.refreshAllWindowColor(), 'skip')