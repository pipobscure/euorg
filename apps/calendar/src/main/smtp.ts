/**
 * SMTP email sender for iTIP calendar invitations.
 *
 * Sends METHOD:REQUEST (invitation) and METHOD:REPLY (accept/decline) emails
 * with an ICS attachment per RFC 6047 (iMIP).
 *
 * Uses nodemailer which is Node.js/Bun compatible.
 */

import nodemailer from "nodemailer";
import type { SmtpConfig } from "@euorg/shared/euorg-accounts.ts";
import { serializeICS, type ICalEvent, type ICalAttendee } from "./ics.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SmtpCredentials extends SmtpConfig {
	password: string;
}

// ── Transport factory ─────────────────────────────────────────────────────────

function createTransport(creds: SmtpCredentials) {
	return nodemailer.createTransport({
		host: creds.host,
		port: creds.port,
		secure: creds.secure,
		auth: { user: creds.username, pass: creds.password },
		tls: {
			// Bun workaround: checkServerIdentity receives null cert when TLS handshake fails
			// (e.g. connecting to a STARTTLS port with secure:true). Guard against the crash
			// and surface a readable error instead of a destructuring TypeError.
			checkServerIdentity: (_host: string, cert: Record<string, unknown> | null) => {
				if (!cert?.subject) {
					return new Error(
						`TLS handshake failed — no certificate received from ${creds.host}:${creds.port}. ` +
						`Check your port/TLS settings: use port 465 with TLS enabled, or port 587 with TLS disabled (STARTTLS).`
					);
				}
				return undefined; // accept
			},
		},
	});
}

// ── Send Invitation (METHOD:REQUEST) ─────────────────────────────────────────

/**
 * Send a calendar invitation to all attendees listed in the event.
 * The ICS attachment uses METHOD:REQUEST.
 */
export async function sendInvitation(
	creds: SmtpCredentials,
	event: ICalEvent,
	calendarName: string,
): Promise<void> {
	if (event.attendees.length === 0) {
		throw new Error("No attendees to send invitation to");
	}

	const icsText = serializeICS(
		{
			uid: event.uid,
			summary: event.summary,
			description: event.description,
			location: event.location,
			startISO: event.dtstart,
			endISO: event.dtend ?? event.dtstart,
			isAllDay: event.dtstartIsDate,
			tzid: event.dtstartTzid ?? undefined,
			rrule: event.rrule ?? undefined,
			organizer: event.organizer,
			attendees: event.attendees.map((a) => ({
				email: a.email,
				cn: a.cn,
				role: a.role,
			})),
			method: "REQUEST",
			sequence: event.sequence,
		},
	);

	const to = event.attendees.map((a) => (a.cn ? `"${a.cn}" <${a.email}>` : a.email)).join(", ");

	const dateStr = formatEventDate(event);
	const bodyText = [
		`You have been invited to: ${event.summary}`,
		``,
		dateStr,
		event.location ? `Location: ${event.location}` : "",
		event.description ? `\n${event.description}` : "",
		``,
		`Sent from ${calendarName} via euorg Calendar`,
	]
		.filter((l) => l !== undefined)
		.join("\n");

	const transport = createTransport(creds);
	await transport.sendMail({
		from: `"${creds.fromName}" <${creds.fromEmail}>`,
		to,
		subject: `Invitation: ${event.summary} - ${dateStr}`,
		text: bodyText,
		attachments: [
			{
				filename: "invite.ics",
				content: icsText,
				contentType: "text/calendar; method=REQUEST; charset=utf-8",
				contentDisposition: "attachment",
			},
		],
	});
}

// ── Send Reply (METHOD:REPLY) ─────────────────────────────────────────────────

/**
 * Send an accept/decline reply back to the event organizer.
 */
export async function sendReply(
	creds: SmtpCredentials,
	event: ICalEvent,
	partstat: "ACCEPTED" | "DECLINED" | "TENTATIVE",
	attendeeEmail: string,
): Promise<void> {
	// Build the reply attendee list (just the replier, with updated partstat)
	const myAttendee = event.attendees.find(
		(a) => a.email.toLowerCase() === attendeeEmail.toLowerCase(),
	);
	const replyAttendee: ICalAttendee = {
		email: attendeeEmail,
		cn: myAttendee?.cn ?? creds.fromName,
		partstat,
		role: myAttendee?.role ?? "REQ-PARTICIPANT",
		rsvp: false,
	};

	const icsText = serializeICS(
		{
			uid: event.uid,
			summary: event.summary,
			startISO: event.dtstart,
			endISO: event.dtend ?? event.dtstart,
			isAllDay: event.dtstartIsDate,
			tzid: event.dtstartTzid ?? undefined,
			organizer: event.organizer,
			existingAttendees: [replyAttendee],
			method: "REPLY",
			sequence: event.sequence,
		},
	);

	const statusText = partstat === "ACCEPTED" ? "accepted" : partstat === "DECLINED" ? "declined" : "tentatively accepted";
	const dateStr = formatEventDate(event);

	const transport = createTransport(creds);
	await transport.sendMail({
		from: `"${creds.fromName}" <${creds.fromEmail}>`,
		to: event.organizer ? `${event.organizer}` : creds.fromEmail,
		subject: `${partstat === "ACCEPTED" ? "Accepted" : partstat === "DECLINED" ? "Declined" : "Tentative"}: ${event.summary}`,
		text: `${creds.fromName} has ${statusText} the event: ${event.summary}\n\n${dateStr}`,
		attachments: [
			{
				filename: "reply.ics",
				content: icsText,
				contentType: "text/calendar; method=REPLY; charset=utf-8",
				contentDisposition: "attachment",
			},
		],
	});
}

// ── Test SMTP ─────────────────────────────────────────────────────────────────

/** Test SMTP connectivity. Returns null on success, error message on failure. */
export async function testSmtp(creds: SmtpCredentials): Promise<string | null> {
	try {
		const transport = createTransport(creds);
		await transport.verify();
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEventDate(event: ICalEvent): string {
	try {
		if (event.dtstartIsDate) {
			const s = event.dtstart;
			return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
		}
		const d = new Date(event.dtstart);
		if (!isNaN(d.getTime())) {
			return d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
		}
		return event.dtstart;
	} catch {
		return event.dtstart;
	}
}
