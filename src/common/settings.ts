import { RemoteSettings } from "../util/webext/settings.js";

export class Settings {
	version = 0

	excludePinnedTabs = false
	discardInactiveTabs = true
	discardInactiveTabsFavicon: 'load' | '' = ''

	theme = 'auto'
	toolbarIcon: 'bookmark-folder' | 'folder' | 'folder-filled' = 'bookmark-folder'
	groupIcon: 'bookmark-folder' | 'folder' | 'folder-filled' = 'folder'
	autoSetColor = false
}

export const remoteSettings = new RemoteSettings(new Settings)