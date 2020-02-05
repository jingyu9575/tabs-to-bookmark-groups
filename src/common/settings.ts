import { RemoteSettings } from "../util/webext/settings.js";

export class Settings {
	version = 0

	excludePinnedTabs = false
	discardInactiveTabs = true

	theme = 'auto'
}

export const remoteSettings = new RemoteSettings(new Settings)