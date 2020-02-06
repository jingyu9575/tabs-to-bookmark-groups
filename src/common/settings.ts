import { RemoteSettings } from "../util/webext/settings.js";

export class Settings {
	version = 0

	excludePinnedTabs = false
	discardInactiveTabs = true
	discardInactiveTabsFavicon: 'load' | '' = ''

	theme = 'auto'
}

export const remoteSettings = new RemoteSettings(new Settings)