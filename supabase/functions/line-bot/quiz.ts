
// new Quiz({body: 'hello', answer: 'answer'})
export class Quiz {
  _body = "";
  _answer = "";
  constructor({body, answer}) {
    this._body = body;
    this._answer = answer;
  }

  async saveToSupabase(supabaseClient) {
    const { error } = await supabaseClient
      .from('quiz')
      .insert({ answer: this._answer, body: this._body })
    if(error) console.log({caused: "Quiz.saveToSupabase", error})
  }
  savedMessages() {
    return [
      {
        "type": "text",
        "text": `単語：${this._body} / 解答：${this._answer} を登録しました`
      }
    ]
  }
}
