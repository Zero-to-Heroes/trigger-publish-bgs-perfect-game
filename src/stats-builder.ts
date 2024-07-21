/* eslint-disable @typescript-eslint/no-use-before-define */
import { getConnection, S3 } from '@firestone-hs/aws-lambda-utils';
import { AllCardsService } from '@firestone-hs/reference-data';
import { ServerlessMysql } from 'serverless-mysql';
import SqlString from 'sqlstring';
import { uuid } from './db/utils';
import { ReviewMessage } from './review-message';
import { validateReplay } from './validator';

const s3 = new S3();
const cards = new AllCardsService();

export class StatsBuilder {
	public async buildStats(messages: readonly ReviewMessage[], dryRun = false) {
		await cards.initializeCardsDb();
		const mysql = await getConnection();
		await Promise.all(
			messages.filter((msg) => !!msg.buildNumber).map((msg) => this.buildStat(msg.reviewId, mysql)),
		);
		await mysql.end();
	}

	private async buildStat(reviewId: string, mysql: ServerlessMysql) {
		const review = await loadReview(reviewId, mysql);
		console.log('processing', review);
		if (!review.playerRank?.length || parseInt(review.playerRank) <= 4000 || !review.allowGameShare) {
			return;
		}

		const replayString = await this.loadReplayString(review.replayKey);
		// console.log('hophop', message.replayKey, replayString?.length, replayString?.substring(0, 100));
		if (!replayString?.length) {
			return;
		}

		const isValid = validateReplay(replayString);
		if (!isValid) {
			console.log('invalid replay', reviewId);
			return;
		}

		// Now we anonymize the replay string
		const playerCardId = review.playerCardId;
		const anonimizedReplayString = anonymize(replayString, review);
		const newReviewId = uuid();

		// Save the new replay on S3
		const today = new Date();
		const replayKey = `hearthstone/replay/${today.getFullYear()}/${
			today.getMonth() + 1
		}/${today.getDate()}/${newReviewId}.xml.zip`;
		await s3.writeCompressedFile(anonimizedReplayString, 'xml.firestoneapp.com', replayKey);
		const creationDate = toCreationDate(today);
		const escape = SqlString.escape;

		// And we copy the initial post-match stats to s3
		await s3.copy(
			'bgs-post-match-stats.firestoneapp.com',
			`${review.reviewId}.gz.json`,
			`bgs-post-match-stats.firestoneapp.com`,
			`${newReviewId}.gz.json`,
		);

		// And we republish the review
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
				gameDurationTurns,
				finalComp,
				anomalies
			)
			VALUES
			(
				${nullIfEmpty(newReviewId)},
				${nullIfEmpty(creationDate)},
				${nullIfEmpty(review.reviewId)},
				${nullIfEmpty(review.creationDate)},
				${nullIfEmpty(review.buildNumber)},
				${nullIfEmpty(playerCardId)},
				${nullIfEmpty(review.playerRank)},
				${nullIfEmpty(replayKey)},
				${nullIfEmpty(review.bgsAvailableTribes)},
				${nullIfEmpty(review.bgsBannedTribes)},
				${nullIfEmpty(escape(review.totalDurationSeconds))},
				${nullIfEmpty(escape(review.totalDurationTurns))},
				${nullIfEmpty(review.finalComp)},
				${nullIfEmpty(review.bgsAnomalies)}
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
	return `${today.toISOString().slice(0, 19).replace('T', ' ')}.${today.getMilliseconds()}`;
};

const loadReview = async (reviewId: string, mysql: ServerlessMysql) => {
	return new Promise<any>((resolve) => {
		loadReviewInternal(reviewId, mysql, (review) => resolve(review), null);
	});
};

const loadReviewInternal = async (
	reviewId: string,
	mysql: ServerlessMysql,
	callback,
	previousReview,
	retriesLeft = 15,
) => {
	if (retriesLeft <= 0) {
		console.error('Could not load reviews', reviewId);
		callback(previousReview);
		return;
	}
	const query = `
		SELECT * FROM replay_summary 
		WHERE reviewId = ${SqlString.escape(reviewId)}
	`;
	const dbResults: any[] = await mysql.query(query);
	const review = dbResults && dbResults.length > 0 ? dbResults[0] : null;
	if (!review?.bgsAvailableTribes) {
		console.warn('Could not load full review info', review);
		setTimeout(() => loadReviewInternal(reviewId, mysql, callback, review, retriesLeft - 1), 1000);
		return;
	}
	callback(review);
};
