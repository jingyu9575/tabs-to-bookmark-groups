import { applyI18n } from "../util/webext/i18n.js";

applyI18n()

const { searchParams } = new URL(location.href)
const url = searchParams.get('url') || ''

const urlInput = document.getElementById('url') as HTMLInputElement
document.title = urlInput.value = url
urlInput.addEventListener('click', () => { urlInput.select() })

document.getElementById('copy')!.addEventListener('click', () => {
	void navigator.clipboard!.writeText(urlInput.value)
	urlInput.select()
	urlInput.focus()
})

browser.tabs.getCurrent().then(({ id }) => {
	if (!url) return
	browser.tabs.update(id!, { url, loadReplace: true }).catch(() => { })
})