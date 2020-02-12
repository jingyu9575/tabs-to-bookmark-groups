import { remoteProxy } from '../util/webext/remote.js';
import { remoteSettings } from './settings.js';
import { ExtensionPageMenus } from '../util/webext/menu.js';

export const backgroundRemote =
	remoteProxy<import('../background/background').BackgroundRemote>('BackgroundRemote')

export const groupManagerRemote =
	remoteProxy<import('../background/group-manager').GroupManager>('GroupManager')

export async function getWindowTabsToSave(windowId: number,
	discardSingleBlank: boolean) {
	let tabs = (await browser.windows.get(windowId,
		{ populate: true })).tabs!
	if (await remoteSettings.get('excludePinnedTabs'))
		tabs = tabs.filter(v => !v.pinned)
	if (discardSingleBlank && tabs.length === 1) {
		const url = tabs[0].url!.toLowerCase()
		if (['about:blank', 'about:newtab', 'about:home'].includes(url))
			return [] // do not save a single blank tab
		if (url.startsWith('moz-extension:') &&
			url === (await browser.browserSettings.newTabPageOverride.get({})).value)
			return []
	}
	return tabs
}

export const groupColors = [
	'blue', 'red', 'orange', 'purple', 'yellow', 'green'
] as const
export type GroupColor = (typeof groupColors)[number]

export const panelGroupMenus = new ExtensionPageMenus('XGroupElement', [
	'setColor', 'deleteGroup'
], [
	'setColor.none', 'setColor.blue', 'setColor.red', 'setColor.orange',
	'setColor.purple', 'setColor.yellow', 'setColor.green',
])

export const groupColorCodesLight = new Map<GroupColor, string>([
	['blue', 'dodgerblue'],
	['red', '#ee0000'],
	['orange', 'darkorange'],
	['purple', 'mediumpurple'],
	['yellow', '#c0b000'],
	['green', 'green'],
])

export const groupColorCodesDark = new Map<GroupColor, string>([
	['blue', 'deepskyblue'],
	['red', '#ff4050'],
	['orange', 'darkorange'],
	['purple', 'plum'],
	['yellow', 'yellow'],
	['green', 'limegreen'],
])