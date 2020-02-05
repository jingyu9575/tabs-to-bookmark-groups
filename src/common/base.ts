import { M } from "../util/webext/i18n.js";
import { remoteSettings } from "./settings.js";

const subtitle = document.body.dataset.subtitle as keyof I18nMessages
document.title = subtitle ? `${M[subtitle]} - ${M.extensionName}` : M.extensionName

void async function () {
	let { theme } = await remoteSettings.load([
		'theme',
	])
	if (theme === 'auto')
		theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : ''
	document.documentElement.dataset.theme = theme
	if (theme) {
		const node = document.createElement('link')
		node.rel = 'stylesheet'
		node.href = `/common/theme/${encodeURIComponent(theme)}.css`
		document.head.appendChild(node)
	}
}()