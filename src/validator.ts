import { GameTag } from '@firestone-hs/reference-data';
import { Element, ElementTree, parse } from 'elementtree';

export const validateReplay = (replayString: string): boolean => {
	const elementTree = parse(replayString);
	const gameElement = elementTree.find(`.//GameEntity`);
	if (!gameElement) {
		console.warn('No game element');
		return false;
	}

	const turnTag = gameElement.find(`.//Tag[@tag='${GameTag.TURN}']`);
	if (!!turnTag && turnTag.get('value') !== '1') {
		console.warn('Not starting the game on the first turn, returning', turnTag.get('value'));
		return false;
	}

	return true;
};
