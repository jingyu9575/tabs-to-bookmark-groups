import { applyI18n } from "../util/webext/i18n.js";
import { SimpleStorage } from "../util/storage.js";

applyI18n()

const { searchParams } = new URL(location.href)
const url = searchParams.get('url') || ''
document.title = searchParams.get('title') || url

const urlInput = document.getElementById('url') as HTMLInputElement
urlInput.value = url
urlInput.addEventListener('click', () => { urlInput.select() })

document.getElementById('copy')!.addEventListener('click', () => {
	void navigator.clipboard!.writeText(urlInput.value)
	urlInput.select()
	urlInput.focus()
})

browser.tabs.getCurrent().then(async ({ id }) => {
	if (!url) return
	function redirect() {
		void browser.tabs.update(id!, { url, loadReplace: true }).catch(() => { })
	}

	if (Number(searchParams.get('discardFavicon'))) {
		const bookmarkId = searchParams.get('id')
		if (bookmarkId) try {
			const faviconStorage = await SimpleStorage.create('favicon')
			const faviconURL = await faviconStorage.get<string>(bookmarkId) || ''
			if (faviconURL.slice(0, 5).toLowerCase() === 'data:') {
				const link = document.createElement('link')
				link.rel = 'icon'
				link.href = faviconURL
				document.head.appendChild(link)
			}
		} catch (error) { console.error(error) }
		setTimeout(() => {
			void browser.tabs.discard(id!)
			redirect()
		}, 1);
	} else
		redirect()
})