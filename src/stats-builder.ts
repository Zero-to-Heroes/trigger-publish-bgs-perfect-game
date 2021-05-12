/* eslint-disable @typescript-eslint/no-use-before-define */
import { AllCardsService } from '@firestone-hs/reference-data';
import { ServerlessMysql } from 'serverless-mysql';
import SqlString from 'sqlstring';
import { getConnection } from './db/rds';
import { S3 } from './db/s3';
import { uuid } from './db/utils';
// import { fetch } from 'node-fetch';
// import { Rds } from './db/rds';
import { ReviewMessage } from './review-message';

const s3 = new S3();
const cards = new AllCardsService();

export class StatsBuilder {
	public async buildStats(messages: readonly ReviewMessage[], dryRun = false) {
		await cards.initializeCardsDb();
		const mysql = await getConnection();
		await Promise.all(messages.map(msg => this.buildStat(msg, mysql)));
		await mysql.end();
	}

	private async buildStat(message: ReviewMessage, mysql: ServerlessMysql) {
		// console.log('processing', message);
		if (!message.playerRank?.length) {
			return;
		}

		const replayString = await this.loadReplayString(message.replayKey);
		// console.log('hophop', message.replayKey, replayString?.length, replayString?.substring(0, 100));
		if (!replayString || replayString.length === 0) {
			return null;
		}

		// Now we anonymize the replay string
		const playerCardId = message.playerCardId;
		const anonimizedReplayString = anonymize(replayString, message);
		const newReviewId = uuid();

		// Save the new replay on S3
		const today = new Date();
		const replayKey = `hearthstone/replay/${today.getFullYear()}/${today.getMonth() +
			1}/${today.getDate()}/${newReviewId}.xml.zip`;
		await s3.writeCompressedFile(anonimizedReplayString, 'xml.firestoneapp.com', replayKey);
		const creationDate = toCreationDate(today);
		const escape = SqlString.escape;

		// And we republish it
		const query = `
			INSERT INTO bgs_perfect_game
			(
				reviewId,
				creationDate,
				originalReviewId,
				originalCreationDate,
				buildNumber,
				playerCardId,
				playerRank,
				replayKey,
				bgsAvailableTribes,
				bgsBannedTribes,
				gameDurationSeconds,
				gameDurationTurns
			)
			VALUES
			(
				${nullIfEmpty(newReviewId)},
				${nullIfEmpty(creationDate)},
				${nullIfEmpty(message.reviewId)},
				${nullIfEmpty(message.creationDate)},
				${nullIfEmpty(message.buildNumber)},
				${nullIfEmpty(playerCardId)},
				${nullIfEmpty(message.playerRank)},
				${nullIfEmpty(replayKey)},
				${nullIfEmpty(message.bgsAvailableTribes)},
				${nullIfEmpty(message.bgsBannedTribes)},
				${nullIfEmpty(escape(message.totalDurationSeconds))},
				${nullIfEmpty(escape(message.totalDurationTurns))}
			)
		`;
		await mysql.query(query);
		return;
	}

	private async loadReplayString(replayKey: string): Promise<string> {
		if (!replayKey) {
			return null;
		}
		const data = replayKey.endsWith('.zip')
			? await s3.readZippedContent('xml.firestoneapp.com', replayKey)
			: await s3.readContentAsString('xml.firestoneapp.com', replayKey);
		return data;
	}
}

const anonymize = (replayString: string, review: ReviewMessage): string => {
	const newPlayerName = cards.getCard(review.playerCardId)?.name ?? review.playerCardId;
	const newOpponentName = cards.getCard(review.opponentCardId)?.name ?? review.opponentCardId;
	return replayString
		.replace(new RegExp(review.playerName, 'gm'), newPlayerName)
		.replace(new RegExp(review.opponentName, 'gm'), newOpponentName);
};

const nullIfEmpty = (value: string): string => {
	return value == null || value == 'null' ? 'NULL' : `${SqlString.escape(value)}`;
};

const toCreationDate = (today: Date): string => {
	return `${today
		.toISOString()
		.slice(0, 19)
		.replace('T', ' ')}.${today.getMilliseconds()}`;
};
