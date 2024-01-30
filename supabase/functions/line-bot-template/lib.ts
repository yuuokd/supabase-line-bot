// ChatGPT から作った適当な関数たち
export function shuffle(array) {
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

export const fetchRandom10QuizIds = async(supabaseClient) => {
    const { data, error } = await supabaseClient.from('quiz').select('body,answer')
    return shuffle(data).slice(0, 10)
}
