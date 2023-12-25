// ChatGPT で作った適当な関数たち

// === javascript で最大値を指定して、その間の10個の値をランダムで被りなく抽出する関数を教えてください ===
function getRandomNumbers(max) {
    const numbers = Array.from({length: max}, (_, i) => i + 1);
    const shuffled = shuffle(numbers);
    return shuffled.slice(0, 10);
}

function shuffle(array) {
    let currentIndex = array.length, temporaryValue, randomIndex;

    while (0 !== currentIndex) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
}
