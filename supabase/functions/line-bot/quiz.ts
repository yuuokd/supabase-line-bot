// new Quiz({question: 'hello', answer: 'answer'})
export class Quiz {
  _question = "";
  _answer = "";
  _errorrMessages = [];
  constructor({question, answer}) {
    this._question = question;
    this._answer = answer;
  }

  async saveToSupabase(supabaseClient) {
    const { error } = await supabaseClient
      .from('quiz')
      .insert({ answer: this._answer, question: this._question })
    if(error) console.log({caused: "Quiz.saveToSupabase", error})
  }
  savedMessages() {
    return [
      {
        "type": "text",
        "text": `単語：${this._question} / 解答：${this._answer} を登録しました`
      }
    ]
  }
}
