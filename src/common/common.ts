import { remoteProxy } from '../util/webext/remote.js';

export const backgroundRemote =
	remoteProxy<import('../background/background').BackgroundRemote>('BackgroundRemote')