// Shared types mirroring the main-process structures.

export interface AttachmentRow {
	id: string;
	noteUid: string;
	filename: string;
	mimeType: string;
	size: number;
	storedPath: string;
}

export interface NoteRow {
	uid: string;
	accountId: string;
	folder: string;
	imapUid: number | null;
	subject: string;
	bodyHtml: string;
	createdAt: string;
	modifiedAt: string;
	/** null = synced; 'create' | 'update' | 'delete' = pending push */
	pendingSync: string | null;
	lastSynced: number | null;
	tags: string[];
	attachments: AttachmentRow[];
}

export interface Account {
	id: string;
	name: string;
	host: string;
	port: number;
	secure: boolean;
	username: string;
	enabled: boolean;
	notesFolder: string;
}

export interface SyncProgress {
	phase: string;
	done: number;
	total: number;
	accountName?: string;
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	errors: string[];
}
