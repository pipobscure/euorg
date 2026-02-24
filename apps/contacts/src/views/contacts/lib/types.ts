// Shared types mirroring the main-process structures.
// Kept in sync with db.ts, vcard.ts, and euorg-accounts.ts manually.

export interface ContactRow {
	uid: string;
	accountId: string;
	collectionId: string;
	etag: string | null;
	href: string;
	vcfPath: string;
	displayName: string;
	emails: Array<{ value: string; type: string }>;
	phones: Array<{ value: string; type: string }>;
	org: string | null;
	lastSynced: number | null;
	/** null = synced with server; 'create' | 'update' | 'delete' | 'move' = pending push */
	pendingSync: string | null;
}

export interface VCard {
	uid: string;
	fn: string;
	firstName: string;
	lastName: string;
	middleName: string;
	prefix: string;
	suffix: string;
	emails: Array<{ value: string; type: string }>;
	phones: Array<{ value: string; type: string }>;
	addresses: Array<{
		street: string;
		city: string;
		region: string;
		postcode: string;
		country: string;
		type: string;
		geoLat?: number;
		geoLon?: number;
	}>;
	org: string;
	title: string;
	birthday: string;
	note: string;
	photo: string;
	rev: string;
	raw: string;
}

/** Account as sent to the webview (password omitted). */
export interface Account {
	id: string;
	name: string;
	serverUrl: string;
	username: string;
	enabled: boolean;
	defaultCollectionId: string | null;
}

/** CardDAV collection as sent to the webview. */
export interface Collection {
	id: string;
	accountId: string;
	name: string;
	url: string;
	enabled: boolean;
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	errors: string[];
}

export interface SyncProgress {
	phase: string;
	done: number;
	total: number;
	accountName?: string;
	collectionName?: string;
}

export interface VCardInput {
	uid?: string;
	firstName?: string;
	lastName?: string;
	middleName?: string;
	prefix?: string;
	suffix?: string;
	fn?: string;
	emails?: Array<{ value: string; type: string }>;
	phones?: Array<{ value: string; type: string }>;
	addresses?: Array<{
		street: string;
		city: string;
		region: string;
		postcode: string;
		country: string;
		type: string;
		geoLat?: number;
		geoLon?: number;
	}>;
	org?: string;
	title?: string;
	birthday?: string;
	note?: string;
	photo?: string;
}

export interface AddressSuggestion {
	text: string;
	street: string;
	city: string;
	region: string;
	postcode: string;
	country: string;
	geoLat: number;
	geoLon: number;
}
