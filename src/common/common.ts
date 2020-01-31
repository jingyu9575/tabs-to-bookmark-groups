import { remoteProxy } from '../util/webext/remote.js';
import { remoteSettings } from './settings.js';

export const backgroundRemote =
	remoteProxy<import('../background/background').BackgroundRemote>('BackgroundRemote')

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