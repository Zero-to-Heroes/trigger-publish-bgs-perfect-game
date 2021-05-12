/* eslint-disable @typescript-eslint/no-use-before-define */
import { gzipSync } from 'zlib';
import { getConnection } from './db/rds';
import { S3 } from './db/s3';

const s3 = new S3();

// This example demonstrates a NodeJS 8.10 async handler[1], however of course you could use
// the more traditional callback-style handler.
// [1]: https://aws.amazon.com/blogs/compute/node-js-8-10-runtime-now-available-in-aws-lambda/
export default async (event): Promise<any> => {
	const mysql = await getConnection();

	// const lastBattlegroundsPatch = await getLastBattlegroundsPatch();
	// TODO: add grouping by period, maybe by MMR? Since there are many heroes, how to make sure
	// we have enough for each hero?
	// Maybe in the query itself, pick the 15 latest for each hero? Or even further divide by rank,
	// so that we have 10 for each rank segment?
	const query = `
		SELECT * from bgs_perfect_game
		ORDER BY id desc
		LIMIT 1000;
	`;
	const dbResults: any[] = (await mysql.query(query)) ?? [];
	const results = dbResults.map(result => ({
		...result,
		creationTimestamp: Date.parse(result.creationDate),
	}));
	const stringResults = JSON.stringify(results);
	const gzippedResults = gzipSync(stringResults);
	await s3.writeFile(
		gzippedResults,
		'static.zerotoheroes.com',
		'api/bgs-perfect-games.json',
		'application/json',
		'gzip',
	);

	await mysql.end();

	return { statusCode: 200, body: null };
};
