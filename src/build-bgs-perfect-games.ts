/* eslint-disable @typescript-eslint/no-use-before-define */
import { S3, getConnectionReadOnly } from '@firestone-hs/aws-lambda-utils';
import { BgsBoard } from '@firestone-hs/hs-replay-xml-parser/dist/public-api';
import { inflate } from 'pako';
import { gzipSync } from 'zlib';

const s3 = new S3();

// This example demonstrates a NodeJS 8.10 async handler[1], however of course you could use
// the more traditional callback-style handler.
// [1]: https://aws.amazon.com/blogs/compute/node-js-8-10-runtime-now-available-in-aws-lambda/
export default async (event): Promise<any> => {
	const mysql = await getConnectionReadOnly();

	// const lastBattlegroundsPatch = await getLastBattlegroundsPatch();
	// TODO: add grouping by period, maybe by MMR? Since there are many heroes, how to make sure
	// we have enough for each hero?
	// Maybe in the query itself, pick the 15 latest for each hero? Or even further divide by rank,
	// so that we have 10 for each rank segment?
	const query = `
		SELECT * from bgs_perfect_game
		WHERE playerRank > 4000
		ORDER BY id desc
		LIMIT 1000;
	`;
	const dbResults: any[] = (await mysql.query(query)) ?? [];
	await mysql.end();
	const results = dbResults
		.map((result) => ({
			...result,
			creationTimestamp: Date.parse(result.creationDate),
			bgsAvailableTribes: result.bgsAvailableTribes
				? result.bgsAvailableTribes.split(',').map((tribe) => parseInt(tribe))
				: [],
			bgsBannedTribes: result.bgsBannedTribes
				? result.bgsBannedTribes.split(',').map((tribe) => parseInt(tribe))
				: [],
			bgsAnomalies: result.anomalies ? result.anomalies.split(',') : [],
			postMatchStats: {
				boardHistory: result.finalComp ? [parseStats(result.finalComp)] : [],
			},
		}))
		.filter((r) => r.postMatchStats.boardHistory.length > 0 && r.postMatchStats.boardHistory[0].board?.length <= 7)
		.filter((r) => r.bgsAnomalies?.length < 2);
	const stringResults = JSON.stringify(results);
	const gzippedResults = gzipSync(stringResults);
	await s3.writeFile(
		gzippedResults,
		'static.zerotoheroes.com',
		'api/bgs-perfect-games.json',
		'application/json',
		'gzip',
	);

	return { statusCode: 200, body: null };
};

const parseStats = (inputStats: string): BgsBoard => {
	const fromBase64 = Buffer.from(inputStats, 'base64').toString();
	const inflated = inflate(fromBase64, { to: 'string' });
	return JSON.parse(inflated);
};
