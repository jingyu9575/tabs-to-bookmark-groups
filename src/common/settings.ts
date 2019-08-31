import { RemoteSettings } from "../util/webext/settings.js";

export class Settings {
	version = 0
}

export const remoteSettings = new RemoteSettings(new Settings)